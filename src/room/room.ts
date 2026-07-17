// ─── Room Durable Object — authoritative state + hibernatable WebSockets ───

import { DurableObject } from "cloudflare:workers";
import type {
  InteractionKind,
  PlayerActivity,
  PublicCause,
  RoomState,
} from "../shared/domain.js";
import type {
  ClientCommand,
  ClientMessage,
  DomainErrorCode,
  ServerMessage,
} from "../shared/protocol.js";
import { DomainError, isValidName } from "../shared/validation.js";
import {
  addPlayer,
  createPlayer,
  initializeRoomState,
  isExpired,
  readySet,
  readyUnset,
  rematchSet,
  submitGuess,
} from "./engine.js";
import { toPublicRoomView } from "./public-view.js";
import { deleteAllState, loadState, saveState } from "./storage.js";

type SocketAttachment = {
  playerId: string;
  connectedAt: number;
  activity: PlayerActivity;
  lastInteractionAt: number;
};

type CommandBody = ClientCommand<string, Record<string, unknown>>;
type CommandResult = { cause?: PublicCause; duplicate?: boolean };

const INTERACTIONS = new Set<InteractionKind>(["nudge", "almost", "nice", "rematch"]);
const INTERACTION_COOLDOWN_MS = 3_000;

export interface RoomEnv {
  WS_TICKET_SECRET: string;
}

export class Room extends DurableObject<RoomEnv> {
  private state: RoomState | null = null;
  private loaded = false;

  async fetch(request: Request): Promise<Response> {
    await this.load();
    const path = new URL(request.url).pathname;

    if (path.endsWith("/socket") && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleWsUpgrade(request);
    }
    if (path.endsWith("/init") && request.method === "POST") return this.handleInit(request);
    if (path.endsWith("/join") && request.method === "POST") return this.handleJoin(request);
    if (path.endsWith("/socket-ticket") && request.method === "POST") return this.handleTicket(request);
    if (path.endsWith("/state") && request.method === "GET") return this.handleState(request);
    if (path.endsWith("/command") && request.method === "POST") return this.handleHttpCommand(request);

    return this.errorRes("ROOM_NOT_FOUND", "未知操作", 404);
  }

  private async handleInit(request: Request): Promise<Response> {
    if (this.state) return this.errorRes("COMMAND_REJECTED", "房间已存在", 409, "ALREADY_EXISTS");
    const body = await reqJson(request);
    const name = String(body?.name || "");
    const tokenHash = String(body?.tokenHash || "");
    const roomCode = String(body?.roomCode || "");
    if (!isValidName(name)) return this.errorRes("INVALID_NAME", "昵称不合法", 400);

    const player = createPlayer(crypto.randomUUID(), name, tokenHash, 1);
    this.state = initializeRoomState(roomCode, player, Date.now());
    await this.persist();
    return this.jsonRes({ playerId: player.id, roomState: this.publicView(player.id) });
  }

  private async handleJoin(request: Request): Promise<Response> {
    if (!this.state) return this.roomNotFound();
    const body = await reqJson(request);
    const name = String(body?.name || "");
    const tokenHash = String(body?.tokenHash || "");
    if (!isValidName(name)) return this.errorRes("INVALID_NAME", "昵称不合法", 400);

    const existing = this.state.players.find((p) => p.tokenHash === tokenHash);
    if (existing) {
      return this.jsonRes({
        playerId: existing.id,
        playerToken: "",
        roomState: this.publicView(existing.id),
      });
    }
    if (this.state.players.length >= 2) return this.errorRes("ROOM_FULL", "房间已满", 409);

    const { generatePlayerToken, hashToken } = await import("../worker/auth.js");
    const playerId = crypto.randomUUID();
    const token = generatePlayerToken();
    const player = createPlayer(playerId, name, await hashToken(token), 2);
    try {
      this.state = addPlayer(this.state, player, Date.now());
      await this.persist();
      this.broadcastState({ type: "player.joined", playerId });
      return this.jsonRes({
        playerId,
        playerToken: token,
        roomState: this.publicView(playerId),
      });
    } catch (error) {
      return this.domainError(error);
    }
  }

  private async handleTicket(request: Request): Promise<Response> {
    const player = await this.authenticate(request);
    if (!player || !this.state) return this.errorRes("UNAUTHORIZED", "凭证无效", 401);
    if (!this.env.WS_TICKET_SECRET) return this.errorRes("INTERNAL_ERROR", "服务未配置", 500);

    const { signTicket } = await import("../worker/auth.js");
    const claims = {
      roomCode: this.state.roomCode,
      playerId: player.id,
      expiresAt: Date.now() + 60_000,
      nonce: crypto.randomUUID(),
    };
    return this.jsonRes({
      ticket: await signTicket(this.env.WS_TICKET_SECRET, claims),
      expiresAt: claims.expiresAt,
    });
  }

  private async handleState(request: Request): Promise<Response> {
    const player = await this.authenticate(request);
    if (!player) return this.errorRes("UNAUTHORIZED", "凭证无效", 401);
    return this.jsonRes({ state: this.publicView(player.id) });
  }

  private async handleHttpCommand(request: Request): Promise<Response> {
    const player = await this.authenticate(request);
    if (!player || !this.state) return this.errorRes("UNAUTHORIZED", "凭证无效", 401);
    const body = await reqJson(request) as CommandBody | null;
    if (!body) return this.errorRes("INVALID_INPUT", "无效命令", 400);

    try {
      const result = await this.applyCommand(player.id, body);
      if (result.cause) this.broadcastState(result.cause);
      return this.jsonRes({
        success: true,
        version: this.state.version,
        cause: result.cause,
        duplicate: result.duplicate ?? false,
      });
    } catch (error) {
      return this.domainErrorToJson(error, this.state.version);
    }
  }

  private async handleWsUpgrade(request: Request): Promise<Response> {
    if (!this.state) return this.roomNotFound();
    // This header is injected only after the outer Worker verifies the signed ticket.
    const playerId = request.headers.get("X-Verified-Player-Id") || "";
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    if (!player) return this.errorRes("UNAUTHORIZED", "玩家不在房间", 401);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment?.playerId === playerId) {
        try { socket.close(4001, "replaced"); } catch { /* already closed */ }
      }
    }

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      playerId,
      connectedAt: Date.now(),
      activity: "idle",
      lastInteractionAt: 0,
    } satisfies SocketAttachment);

    const snapshot: ServerMessage = {
      type: "room.snapshot",
      version: this.state.version,
      state: this.publicView(playerId),
    };
    server.send(JSON.stringify(snapshot));
    this.broadcastPresence(playerId, true, "idle");

    return new Response(null, { status: 101, webSocket: client } as never);
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment || !this.state || typeof raw !== "string") return;

    try {
      const message = JSON.parse(raw) as ClientMessage;
      if (message.type === "presence.update") {
        const activity: PlayerActivity = ["idle", "typing", "thinking"].includes(message.activity)
          ? message.activity
          : "idle";
        socket.serializeAttachment({ ...attachment, activity });
        this.broadcastPresence(attachment.playerId, true, activity);
        return;
      }

      if (message.type === "interaction.send") {
        if (!INTERACTIONS.has(message.interaction)) return;
        const now = Date.now();
        if (now - attachment.lastInteractionAt < INTERACTION_COOLDOWN_MS) return;
        socket.serializeAttachment({ ...attachment, lastInteractionAt: now });
        this.sendToOpponent(attachment.playerId, {
          type: "interaction.received",
          fromPlayerId: attachment.playerId,
          interaction: message.interaction,
          createdAt: now,
        });
        return;
      }

      if (message.type === "state.request") {
        socket.send(JSON.stringify({
          type: "room.snapshot",
          version: this.state.version,
          state: this.publicView(attachment.playerId),
        } satisfies ServerMessage));
        return;
      }

      const result = await this.applyCommand(attachment.playerId, message as CommandBody);
      if (result.cause) this.broadcastState(result.cause);
      else if (result.duplicate) {
        socket.send(JSON.stringify({
          type: "room.snapshot",
          version: this.state.version,
          state: this.publicView(attachment.playerId),
        } satisfies ServerMessage));
      }
      socket.send(JSON.stringify({
        type: "command.ack",
        commandId: (message as CommandBody).commandId,
        version: this.state.version,
      } satisfies ServerMessage));
    } catch (error) {
      const domain = error instanceof DomainError
        ? error
        : new DomainError("INTERNAL_ERROR", "内部错误");
      const commandId = safeCommandId(raw);
      try {
        socket.send(JSON.stringify({
          type: "command.error",
          commandId,
          code: domain.code,
          message: domain.message,
          currentVersion: this.state?.version ?? 0,
        } satisfies ServerMessage));
      } catch { /* socket is gone */ }
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) return;
    const stillConnected = this.ctx.getWebSockets().some((candidate) => {
      if (candidate === socket) return false;
      return readAttachment(candidate)?.playerId === attachment.playerId;
    });
    this.broadcastPresence(attachment.playerId, stillConnected, "idle");

    // 双方都断连 → 设 5 分钟清理 alarm
    if (this.state && !this.hasAnyConnection()) {
      const cleanupAt = Date.now() + 5 * 60 * 1000;
      await this.ctx.storage.setAlarm(cleanupAt);
    }
  }

  webSocketError(socket: WebSocket): void {
    try { socket.close(1011, "socket error"); } catch { /* already closed */ }
  }

  async alarm(): Promise<void> {
    await this.load();
    if (!this.state) return;

    // 双方断连超时清理：alarm 触发时仍无连接 → 直接清房
    if (!this.hasAnyConnection()) {
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(4002, "cleanup"); } catch { /* already closed */ }
      }
      await deleteAllState(this.ctx.storage);
      this.state = null;
      return;
    }

    // 有人重连了 → 恢复正常过期
    if (!isExpired(this.state, Date.now())) {
      await this.ctx.storage.setAlarm(this.state.expiresAt);
      return;
    }
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "room.expired" } satisfies ServerMessage));
        socket.close(4002, "expired");
      } catch { /* already closed */ }
    }
    await deleteAllState(this.ctx.storage);
    this.state = null;
  }

  private hasAnyConnection(): boolean {
    return this.ctx.getWebSockets().length > 0;
  }

  private async applyCommand(playerId: string, body: CommandBody): Promise<CommandResult> {
    if (!this.state) throw new DomainError("ROOM_NOT_FOUND", "房间不存在");
    if (!body.commandId || typeof body.expectedVersion !== "number") {
      throw new DomainError("INVALID_INPUT", "命令格式错误");
    }
    const payload = body.payload || {};
    const now = Date.now();

    switch (body.type) {
      case "ready.set": {
        const previousPhase = this.state.phase;
        const { state } = readySet(this.state, playerId, String(payload.secret || ""), body.commandId, now);
        const duplicate = state === this.state;
        this.state = state;
        if (!duplicate) await this.persist();
        return {
          duplicate,
          cause: duplicate ? undefined : previousPhase !== state.phase && state.currentGame
            ? { type: "game.started", firstPlayerId: state.currentGame.firstPlayerId }
            : { type: "ready.changed", playerId, ready: true },
        };
      }
      case "ready.unset": {
        const { state } = readyUnset(this.state, playerId, body.commandId, now);
        const duplicate = state === this.state;
        this.state = state;
        if (!duplicate) await this.persist();
        return { duplicate, cause: duplicate ? undefined : { type: "ready.changed", playerId, ready: false } };
      }
      case "guess.submit": {
        const guess = String(payload.guess || "");
        const result = submitGuess(this.state, playerId, guess, body.commandId, body.expectedVersion, now);
        this.state = result.state;
        if (!result.duplicate) await this.persist();
        return {
          duplicate: result.duplicate,
          cause: result.hitResult ? {
            type: "guess.resolved",
            playerId,
            guess,
            hits: result.hitResult.hits,
            won: result.hitResult.won,
          } : undefined,
        };
      }
      case "rematch.set": {
        const previousPhase = this.state.phase;
        const ready = Boolean(payload.ready);
        const { state } = rematchSet(this.state, playerId, ready, body.commandId, now);
        const duplicate = state === this.state;
        this.state = state;
        if (!duplicate) await this.persist();
        return {
          duplicate,
          cause: duplicate ? undefined : previousPhase !== state.phase && state.previousLoserId
            ? { type: "game.reset", firstPlayerId: state.previousLoserId }
            : { type: "rematch.changed", playerId, ready },
        };
      }
      default:
        throw new DomainError("COMMAND_REJECTED", `未知命令: ${body.type}`);
    }
  }

  private broadcastState(cause: PublicCause): void {
    if (!this.state) return;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment) continue;
      this.send(socket, {
        type: "room.updated",
        version: this.state.version,
        cause,
        state: this.publicView(attachment.playerId),
      });
    }
  }

  private broadcastPresence(playerId: string, connected: boolean, activity: PlayerActivity): void {
    const message: ServerMessage = { type: "presence.updated", playerId, connected, activity };
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }

  private sendToOpponent(playerId: string, message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment && attachment.playerId !== playerId) this.send(socket, message);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try { socket.send(JSON.stringify(message)); } catch { /* reconnect will restore state */ }
  }

  private publicView(playerId: string) {
    if (!this.state) throw new DomainError("ROOM_NOT_FOUND", "房间不存在");
    const presence = new Map<string, { connected: boolean; activity: PlayerActivity }>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment) presence.set(attachment.playerId, { connected: true, activity: attachment.activity });
    }
    return toPublicRoomView(this.state, playerId, presence);
  }

  private async authenticate(request: Request) {
    if (!this.state) return null;
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return null;
    const { hashToken } = await import("../worker/auth.js");
    const tokenHash = await hashToken(token);
    return this.state.players.find((player) => player.tokenHash === tokenHash) ?? null;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.state = await loadState(this.ctx.storage);
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    await saveState(this.ctx.storage, this.state);
    await this.ctx.storage.setAlarm(this.state.expiresAt);
  }

  private roomNotFound(): Response {
    return this.errorRes("ROOM_NOT_FOUND", "房间不存在", 404);
  }

  private jsonRes(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  private errorRes(code: DomainErrorCode, message: string, status: number, overrideCode?: string): Response {
    return this.jsonRes({ error: { code: overrideCode || code, message }, requestId: crypto.randomUUID() }, status);
  }

  private domainError(error: unknown): Response {
    if (error instanceof DomainError) return this.errorRes(error.code, error.message, domainStatus(error.code));
    console.error(error);
    return this.errorRes("INTERNAL_ERROR", "内部错误", 500);
  }

  private domainErrorToJson(error: unknown, version: number): Response {
    if (error instanceof DomainError) {
      return this.jsonRes({ success: false, error: { code: error.code, message: error.message }, version }, domainStatus(error.code));
    }
    console.error(error);
    return this.jsonRes({ success: false, error: { code: "INTERNAL_ERROR", message: "内部错误" }, version }, 500);
  }
}

function readAttachment(socket: WebSocket): SocketAttachment | null {
  try { return socket.deserializeAttachment() as SocketAttachment | null; } catch { return null; }
}

function safeCommandId(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { commandId?: unknown };
    return typeof parsed.commandId === "string" ? parsed.commandId : "";
  } catch { return ""; }
}

function domainStatus(code: DomainErrorCode): number {
  switch (code) {
    case "ROOM_NOT_FOUND": return 404;
    case "UNAUTHORIZED":
    case "TICKET_INVALID": return 401;
    case "ROOM_FULL":
    case "VERSION_CONFLICT": return 409;
    default: return 400;
  }
}

async function reqJson(request: Request): Promise<Record<string, unknown> | null> {
  try { return await request.json() as Record<string, unknown>; } catch { return null; }
}
