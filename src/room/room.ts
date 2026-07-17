// ─── Room Durable Object ───

import { DurableObject } from "cloudflare:workers";
import type {
  RoomState,
  PublicCause,
} from "../shared/domain.js";
import type {
  ServerMessage,
  RoomSnapshot,
  RoomUpdated,
  RoomExpired,
  CommandError,
} from "../shared/protocol.js";
import type { DomainErrorCode } from "../shared/protocol.js";
import { DomainError } from "../shared/validation.js";
import {
  readySet,
  readyUnset,
  submitGuess,
  rematchSet,
  isExpired,
} from "./engine.js";
import { toPublicRoomView } from "./public-view.js";
import { loadState, saveState, deleteAllState } from "./storage.js";

// ─── WebSocket attachment ───

type SocketAttachment = {
  playerId: string;
  connectedAt: number;
};

// ─── Env ───

export interface RoomEnv {
  WS_TICKET_SECRET: string;
}

export class Room extends DurableObject<RoomEnv> {
  private state: RoomState | null = null;
  private loaded = false;

  // ─── HTTP 处理 ───

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    await this.ensureLoaded();

    // 处理 WebSocket 升级（自定义 header，因为 Upgrade 在 DO 间通信中被剥离）
    if (request.headers.get("X-DO-WS-Upgrade") === "1") {
      return this.handleWebSocketUpgrade(request);
    }

    // 路由
    if (path.endsWith("/init") && request.method === "POST") {
      return this.handleInit(request);
    }

    if (path.endsWith("/join") && request.method === "POST") {
      return this.handleJoin(request);
    }

    if (path.endsWith("/socket-ticket") && request.method === "POST") {
      return this.handleSocketTicket(request);
    }

    return this.errorRes("ROOM_NOT_FOUND", "未知操作", 404);
  }

  // ─── 初始化房间 ───

  private async handleInit(request: Request): Promise<Response> {
    // 已初始化则返回冲突
    if (this.state) {
      return this.errorRes("COMMAND_REJECTED", "房间已存在", 409, "ALREADY_EXISTS");
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name : "";

    const { generatePlayerToken, hashToken } = await import("../worker/auth.js");
    const { createPlayer, initializeRoomState } = await import("./engine.js");

    const playerId = crypto.randomUUID();
    const token = generatePlayerToken();
    const tokenHash = await hashToken(token);
    const player = createPlayer(playerId, name, tokenHash, 1);
    this.state = initializeRoomState(this.getRoomCode(), player, Date.now());
    await this.persist();

    return this.jsonRes({ playerToken: token, playerId });
  }

  // ─── 加入房间 ───

  private async handleJoin(request: Request): Promise<Response> {
    if (!this.state) {
      return this.errorRes("ROOM_NOT_FOUND", "房间不存在", 404);
    }

    const maxPlayers = 2;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const tokenHash = typeof body?.tokenHash === "string" ? body.tokenHash : "";

    try {
      const { generatePlayerToken, hashToken } = await import("../worker/auth.js");
      const { addPlayer, createPlayer } = await import("./engine.js");
      const playerId = crypto.randomUUID();

      // 检查是否满员
      if (this.state.players.length >= maxPlayers) {
        return this.errorRes("ROOM_FULL", "房间已满", 409);
      }

      // 检查是否已加入（通过 tokenHash）
      const existing = this.state.players.find((p) => p.tokenHash === tokenHash);
      if (existing) {
        return this.jsonRes({
          playerId: existing.id,
          playerToken: "", // 不发新 token，客户端用 localStorage 的
          roomState: this.publicView(existing.id),
        });
      }

      const token = generatePlayerToken();
      const hash = await hashToken(token);
      const seat = (this.state.players.length + 1) as 1 | 2;
      const player = createPlayer(playerId, name, hash, seat);

      this.state = addPlayer(this.state, player, Date.now());
      await this.persist();

      // 广播
      this.broadcast("player.joined", { type: "player.joined", playerId });

      return this.jsonRes({
        playerId,
        playerToken: token,
        roomState: this.publicView(playerId),
      });
    } catch (err) {
      return this.domainError(err);
    }
  }

  // ─── WebSocket ticket ───

  private async handleSocketTicket(request: Request): Promise<Response> {
    if (!this.state) {
      return this.errorRes("ROOM_NOT_FOUND", "房间不存在", 404);
    }

    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (!token) {
      return this.errorRes("UNAUTHORIZED", "缺少凭证", 401);
    }

    const { hashToken } = await import("../worker/auth.js");
    const tokenHash = await hashToken(token);
    const player = this.state.players.find((p) => p.tokenHash === tokenHash);

    if (!player) {
      return this.errorRes("UNAUTHORIZED", "凭证无效", 401);
    }

    const { signTicket } = await import("../worker/auth.js");
    const secret = this.env.WS_TICKET_SECRET || "dev-secret";
    const nonce = crypto.randomUUID();
    const claims = {
      roomCode: this.state.roomCode,
      playerId: player.id,
      expiresAt: Date.now() + 60_000, // 60 秒
      nonce,
    };

    const ticket = await signTicket(secret, claims);
    return this.jsonRes({ ticket, expiresAt: claims.expiresAt });
  }

  // ─── WebSocket 处理 ───

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    if (!this.state) {
      return new Response("房间不存在", { status: 404 });
    }

    // ticket 从 body 读取（Worker 已从 query 提取）
    let ticket = "";
    try {
      const body = await request.json() as { ticket?: string };
      ticket = body.ticket || "";
    } catch {
      // fallback: try query
      const url = new URL(request.url);
      ticket = url.searchParams.get("ticket") || "";
    }

    // 验证 ticket
    const { verifyTicket } = await import("../worker/auth.js");
    const secret = this.env.WS_TICKET_SECRET || "dev-secret";
    const claims = await verifyTicket(secret, ticket);

    if (!claims || claims.roomCode !== this.state.roomCode) {
      return new Response("ticket 无效或已过期", { status: 401 });
    }

    const player = this.state.players.find((p) => p.id === claims.playerId);
    if (!player) {
      return new Response("玩家不在房间中", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 关闭该玩家的旧连接
    const existingSockets = this.ctx.getWebSockets();
    for (const ws of existingSockets) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att?.playerId === player.id) {
        try { ws.close(4001, "replaced by new connection"); } catch { /* noop */ }
      }
    }

    this.ctx.acceptWebSocket(server as never);
    (server as WebSocket).serializeAttachment({
      playerId: player.id,
      connectedAt: Date.now(),
    } satisfies SocketAttachment);

    // 立即发送当前 snapshot
    const snapshot: ServerMessage = {
      type: "room.snapshot",
      version: this.state.version,
      state: this.publicView(player.id),
    };
    (server as WebSocket).send(JSON.stringify(snapshot));

    // 广播更新（通知对方新连接）
    const cause: PublicCause = { type: "player.joined", playerId: player.id };
    this.broadcast("player.joined", cause, player.id);

    return new Response(null, { status: 101, webSocket: client as never });
  }

  // ─── WebSocket 消息处理 ───

  async webSocketMessage(ws: WebSocket, raw: string) {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att || !this.state) return;

    try {
      const msg = JSON.parse(raw);
      const { type, commandId, expectedVersion, payload } = msg;

      switch (type) {
        case "ready.set":
          await this.handleReadySet(att.playerId, payload.secret, commandId, expectedVersion);
          break;
        case "ready.unset":
          await this.handleReadyUnset(att.playerId, commandId, expectedVersion);
          break;
        case "guess.submit":
          await this.handleGuessSubmit(att.playerId, payload.guess, commandId, expectedVersion);
          break;
        case "rematch.set":
          await this.handleRematchSet(att.playerId, payload.ready, commandId, expectedVersion);
          break;
        case "state.request":
          await this.sendSnapshot(ws, att.playerId);
          break;
        default:
          this.sendError(ws, commandId || "", "COMMAND_REJECTED", "未知命令", this.state.version);
      }
    } catch {
      this.sendError(ws, "", "INVALID_INPUT", "无效的 JSON 消息", this.state?.version ?? 0);
    }
  }

  webSocketClose(ws: WebSocket) {
    // 连接关闭；广播在线状态变化
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (att && this.state) {
      this.broadcastToAll(this.state.version, undefined);
    }
  }

  webSocketError(_ws: WebSocket, _err: unknown) {
    // 静默处理
  }

  // ─── 命令处理 ───

  private async handleReadySet(playerId: string, secret: string, commandId: string, expectedVersion: number) {
    try {
      const { state } = readySet(this.state!, playerId, secret, commandId, Date.now());
      this.state = state;
      await this.persist();

      const cause: PublicCause = { type: "ready.changed", playerId, ready: true };
      this.broadcastToAll(this.state.version, cause);

      // 如果游戏开始了
      if (state.phase === "playing" && state.currentGame) {
        const gameCause: PublicCause = {
          type: "game.started",
          firstPlayerId: state.currentGame.firstPlayerId,
        };
        this.broadcastToAll(this.state.version, gameCause);
      }
    } catch (err) {
      this.domainErrorToWS(playerId, commandId, err);
    }
  }

  private async handleReadyUnset(playerId: string, commandId: string, expectedVersion: number) {
    try {
      const { state } = readyUnset(this.state!, playerId, commandId, Date.now());
      this.state = state;
      await this.persist();

      const cause: PublicCause = { type: "ready.changed", playerId, ready: false };
      this.broadcastToAll(this.state.version, cause);
    } catch (err) {
      this.domainErrorToWS(playerId, commandId, err);
    }
  }

  private async handleGuessSubmit(playerId: string, guess: string, commandId: string, expectedVersion: number) {
    try {
      const { state, hitResult } = submitGuess(
        this.state!, playerId, guess, commandId, expectedVersion, Date.now(),
      );
      this.state = state;
      await this.persist();

      const cause: PublicCause = {
        type: "guess.resolved",
        playerId,
        guess,
        hits: hitResult.hits,
        won: hitResult.won,
      };
      this.broadcastToAll(this.state.version, cause);
    } catch (err) {
      this.domainErrorToWS(playerId, commandId, err);
    }
  }

  private async handleRematchSet(playerId: string, ready: boolean, commandId: string, expectedVersion: number) {
    try {
      const { state } = rematchSet(this.state!, playerId, ready, commandId, Date.now());
      this.state = state;
      await this.persist();

      const cause: PublicCause = { type: "rematch.changed", playerId, ready };
      this.broadcastToAll(this.state.version, cause);

      // 如果重置了
      if (state.phase === "preparing" && state.completedGames.length > 0) {
        const prevLoser = state.previousLoserId;
        if (prevLoser) {
          const gameCause: PublicCause = { type: "game.reset", firstPlayerId: prevLoser };
          this.broadcastToAll(this.state.version, gameCause);
        }
      }
    } catch (err) {
      this.domainErrorToWS(playerId, commandId, err);
    }
  }

  // ─── 广播 ───

  private broadcastToAll(version: number, cause: PublicCause | undefined) {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att) continue;

      if (cause) {
        const msg: RoomUpdated = {
          type: "room.updated",
          version,
          cause,
          state: this.publicView(att.playerId),
        };
        try { ws.send(JSON.stringify(msg)); } catch { /* noop */ }
      } else {
        // 无 cause，只发 snapshot
        const msg: RoomSnapshot = {
          type: "room.snapshot",
          version,
          state: this.publicView(att.playerId),
        };
        try { ws.send(JSON.stringify(msg)); } catch { /* noop */ }
      }
    }
  }

  private broadcast(_event: string, cause: PublicCause, excludePlayerId?: string) {
    this.broadcastToAll(this.state!.version, cause);
  }

  private sendSnapshot(ws: WebSocket, playerId: string) {
    const msg: RoomSnapshot = {
      type: "room.snapshot",
      version: this.state!.version,
      state: this.publicView(playerId),
    };
    try { ws.send(JSON.stringify(msg)); } catch { /* noop */ }
  }

  private sendError(ws: WebSocket, commandId: string, code: DomainErrorCode, message: string, currentVersion: number) {
    const msg: CommandError = {
      type: "command.error",
      commandId,
      code,
      message,
      currentVersion,
    };
    try { ws.send(JSON.stringify(msg)); } catch { /* noop */ }
  }

  private domainErrorToWS(playerId: string, commandId: string, err: unknown) {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att?.playerId === playerId) {
        if (err instanceof DomainError) {
          this.sendError(ws, commandId, err.code, err.message, this.state?.version ?? 0);
        } else {
          this.sendError(ws, commandId, "INTERNAL_ERROR", "服务端错误", this.state?.version ?? 0);
        }
      }
    }
  }

  // ─── Alarm ───

  async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (!this.state) return;

    if (!isExpired(this.state, Date.now())) {
      // 还没到 expiresAt，重设 alarm
      await this.ctx.storage.setAlarm(this.state.expiresAt);
      return;
    }

    // 通知客户端
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(JSON.stringify({ type: "room.expired" } satisfies RoomExpired));
        ws.close(4002, "room expired");
      } catch { /* noop */ }
    }

    await deleteAllState(this.ctx.storage);
  }

  // ─── 辅助 ───

  private getRoomCode(): string {
    // Durable Object created with idFromName(roomCode)
    return String(this.ctx.id);
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    this.state = await loadState(this.ctx.storage);
    this.loaded = true;
  }

  private async persist() {
    if (!this.state) return;
    await saveState(this.ctx.storage, this.state);
    await this.ctx.storage.setAlarm(this.state.expiresAt);
  }

  private publicView(viewerPlayerId: string | null) {
    if (!this.state) throw new DomainError("INTERNAL_ERROR", "无房间状态");
    const presence = new Map<string, boolean>();
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att) presence.set(att.playerId, true);
    }
    return toPublicRoomView(this.state, viewerPlayerId, presence);
  }

  private jsonRes(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  private errorRes(code: DomainErrorCode, message: string, status: number, overrideCode?: string) {
    return this.jsonRes(
      { error: { code: overrideCode || code, message }, requestId: crypto.randomUUID() },
      status,
    );
  }

  private domainError(err: unknown) {
    if (err instanceof DomainError) {
      return this.errorRes(err.code, err.message, domainErrorStatus(err.code));
    }
    console.error("Unexpected error:", err);
    return this.errorRes("INTERNAL_ERROR", "服务端内部错误", 500);
  }
}

function domainErrorStatus(code: DomainErrorCode): number {
  switch (code) {
    case "ROOM_NOT_FOUND": return 404;
    case "UNAUTHORIZED":
    case "TICKET_INVALID": return 401;
    case "ROOM_FULL": return 409;
    case "VERSION_CONFLICT": return 409;
    case "WRONG_PHASE":
    case "NOT_YOUR_TURN":
    case "ALREADY_READY":
    case "COMMAND_REJECTED":
    case "INVALID_INPUT":
    case "INVALID_NAME":
    case "INVALID_SECRET":
    case "INVALID_GUESS": return 400;
    case "INTERNAL_ERROR": return 500;
  }
}
