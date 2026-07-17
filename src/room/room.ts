// ─── Room Durable Object（纯 HTTP 状态存储） ───
// WebSocket 由 Worker 直接处理，DO 只负责状态读写

import { DurableObject } from "cloudflare:workers";
import type { RoomState } from "../shared/domain.js";
import type { DomainErrorCode } from "../shared/protocol.js";
import { DomainError, isValidName, isValidGuess } from "../shared/validation.js";
import {
  initializeRoomState,
  createPlayer,
  addPlayer,
  readySet,
  readyUnset,
  submitGuess,
  rematchSet,
  isExpired,
} from "./engine.js";
import { loadState, saveState, deleteAllState } from "./storage.js";

// ─── Env ───

export interface RoomEnv {
  WS_TICKET_SECRET: string;
}

export class Room extends DurableObject<RoomEnv> {
  // ─── HTTP 路由 ───

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    await this.load();

    // 初始化
    if (path.endsWith("/init") && request.method === "POST") {
      return this.handleInit(request);
    }

    // 加入
    if (path.endsWith("/join") && request.method === "POST") {
      return this.handleJoin(request);
    }

    // WebSocket ticket
    if (path.endsWith("/socket-ticket") && request.method === "POST") {
      return this.handleSocketTicket(request);
    }

    // 读取状态（Worker 用的）
    if (path.endsWith("/state") && request.method === "GET") {
      return this.jsonRes({ state: this.state });
    }

    // 执行命令（Worker 发的）
    if (path.endsWith("/command") && request.method === "POST") {
      return this.handleCommand(request);
    }

    return this.errorRes("ROOM_NOT_FOUND", "未知操作", 404);
  }

  // ─── 初始化 ───

  private handleInit(request: Request): Response | Promise<Response> {
    if (this.state) {
      return this.errorRes("COMMAND_REJECTED", "房间已存在", 409, "ALREADY_EXISTS");
    }
    return this._init(request);
  }

  private async _init(request: Request): Promise<Response> {
    const body = await reqJson(request);
    const name = String(body?.name || "").slice(0, 16);
    const tokenHash = String(body?.tokenHash || "");

    if (!isValidName(name)) {
      return this.errorRes("INVALID_NAME", "昵称 1~16 个可见字符", 400);
    }

    const playerId = crypto.randomUUID();
    const player = createPlayer(playerId, name, tokenHash, 1);
    // DO name == room code (created via idFromName)
    const roomCode = this.getRoomCode();
    this.state = initializeRoomState(roomCode, player, Date.now());
    await this.persist();

    return this.jsonRes({ playerId });
  }

  // ─── 加入 ───

  private async handleJoin(request: Request): Promise<Response> {
    if (!this.state) return this.roomNotFound();

    const body = await reqJson(request);
    const name = String(body?.name || "").slice(0, 16);
    const tokenHash = String(body?.tokenHash || "");
    let playerToken = "";

    if (!isValidName(name)) {
      return this.errorRes("INVALID_NAME", "昵称 1~16 个可见字符", 400);
    }

    // 已加入过
    const existing = this.state.players.find((p) => p.tokenHash === tokenHash);
    if (existing) {
      return this.jsonRes({
        playerId: existing.id,
        playerToken: "",
        roomState: this.publicView(existing.id),
      });
    }

    if (this.state.players.length >= 2) {
      return this.errorRes("ROOM_FULL", "房间已满", 409);
    }

    const { generatePlayerToken, hashToken } = await import(
      "../worker/auth.js"
    );
    const playerId = crypto.randomUUID();
    playerToken = generatePlayerToken();
    const hash = await hashToken(playerToken);
    const seat = 2 as const;
    const player = createPlayer(playerId, name, hash, seat);

    try {
      this.state = addPlayer(this.state, player, Date.now());
    } catch (e) {
      return this.domainError(e);
    }

    await this.persist();
    return this.jsonRes({
      playerId,
      playerToken,
      roomState: this.publicView(playerId),
    });
  }

  // ─── WebSocket Ticket ───

  private async handleSocketTicket(
    request: Request,
  ): Promise<Response> {
    if (!this.state) return this.roomNotFound();

    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return this.errorRes("UNAUTHORIZED", "缺少凭证", 401);

    const { hashToken } = await import("../worker/auth.js");
    const tokenHash = await hashToken(token);
    const player = this.state.players.find((p) => p.tokenHash === tokenHash);
    if (!player) return this.errorRes("UNAUTHORIZED", "凭证无效", 401);

    const { signTicket } = await import("../worker/auth.js");
    const secret = this.env.WS_TICKET_SECRET || "dev-secret";
    const claims = {
      roomCode: this.state.roomCode,
      playerId: player.id,
      expiresAt: Date.now() + 60_000,
      nonce: crypto.randomUUID(),
    };

    const ticketStr = await signTicket(secret, claims);
    return this.jsonRes({ ticket: ticketStr, expiresAt: claims.expiresAt });
  }

  // ─── 执行命令 ───

  private async handleCommand(request: Request): Promise<Response> {
    if (!this.state) return this.roomNotFound();

    const body = await reqJson(request);
    const {
      action,
      commandId,
      expectedVersion,
      payload,
      playerId,
    } = body as {
      action: string;
      commandId: string;
      expectedVersion: number;
      payload: Record<string, unknown>;
      playerId: string;
    };

    try {
      switch (action) {
        case "ready.set": {
          const secret = String(payload?.secret || "");
          if (!isValidGuess(secret)) throw new DomainError("INVALID_SECRET", "密码不是四位数字");
          const { state } = readySet(this.state, playerId, secret, commandId, Date.now());
          this.state = state;
          const cause = state.phase === "playing" && state.currentGame
            ? { type: "game.started" as const, firstPlayerId: state.currentGame.firstPlayerId }
            : { type: "ready.changed" as const, playerId, ready: true };
          await this.persist();
          return this.jsonRes({ success: true, version: state.version, cause });
        }

        case "ready.unset": {
          const { state } = readyUnset(this.state, playerId, commandId, Date.now());
          this.state = state;
          const cause = { type: "ready.changed" as const, playerId, ready: false };
          await this.persist();
          return this.jsonRes({ success: true, version: state.version, cause });
        }

        case "guess.submit": {
          const guess = String(payload?.guess || "");
          if (!isValidGuess(guess)) throw new DomainError("INVALID_GUESS", "猜测不是四位数字");
          const { state, hitResult } = submitGuess(
            this.state, playerId, guess, commandId, expectedVersion, Date.now(),
          );
          this.state = state;
          const cause = {
            type: "guess.resolved" as const,
            playerId, guess,
            hits: hitResult.hits,
            won: hitResult.won,
          };
          await this.persist();
          return this.jsonRes({ success: true, version: state.version, cause });
        }

        case "rematch.set": {
          const ready = Boolean(payload?.ready);
          const { state } = rematchSet(this.state, playerId, ready, commandId, Date.now());
          this.state = state;

          let cause: { type: string; playerId: string; ready: boolean } | { type: string; firstPlayerId: string };
          if (state.phase === "preparing" && state.completedGames.length > 0 && state.previousLoserId) {
            cause = { type: "game.reset" as const, firstPlayerId: state.previousLoserId };
          } else {
            cause = { type: "rematch.changed" as const, playerId, ready };
          }
          await this.persist();
          return this.jsonRes({ success: true, version: state.version, cause });
        }

        default:
          return this.errorRes("COMMAND_REJECTED", `未知命令: ${action}`, 400);
      }
    } catch (e) {
      return this.domainErrorToJson(e, commandId, this.state?.version || 0);
    }
  }

  // ─── Alarm ───

  async alarm(): Promise<void> {
    await this.load();
    if (!this.state) return;

    if (!isExpired(this.state, Date.now())) {
      await this.ctx.storage.setAlarm(this.state.expiresAt);
      return;
    }

    await deleteAllState(this.ctx.storage);
  }

  // ─── 辅助方法 ───

  private state: RoomState | null = null;
  private loaded = false;

  private async load() {
    if (this.loaded) return;
    this.state = await loadState(this.ctx.storage);
    this.loaded = true;
  }

  private async persist() {
    if (!this.state) return;
    await saveState(this.ctx.storage, this.state);
    await this.ctx.storage.setAlarm(this.state.expiresAt);
  }

  private getRoomCode(): string {
    // DO name is the room code (created via idFromName)
    return String((this.ctx as unknown as { id: { toString: () => string } }).id);
  }

  private roomNotFound() {
    return this.errorRes("ROOM_NOT_FOUND", "房间不存在", 404);
  }

  private publicView(playerId: string | null) {
    if (!this.state) return null;
    // 简单脱敏
    const gameEnded = this.state.phase === "finished";
    return {
      roomCode: this.state.roomCode,
      phase: this.state.phase,
      version: this.state.version,
      players: this.state.players.map((p) => ({
        id: p.id,
        seat: p.seat,
        name: p.name,
        ready: p.ready,
        connected: false,
        secret: gameEnded || p.id === playerId ? p.secret : null,
      })),
      currentGame: this.state.currentGame,
      completedGames: this.state.completedGames.map((g) => ({
        gameNumber: g.gameNumber,
        firstPlayerId: g.firstPlayerId,
        currentPlayerId: g.currentPlayerId,
        winnerPlayerId: g.winnerPlayerId,
        loserPlayerId: g.loserPlayerId,
        startedAt: g.startedAt,
        finishedAt: g.finishedAt,
        turns: g.turns,
      })),
      previousLoserId: this.state.previousLoserId,
      rematchReadyPlayerIds: this.state.rematchReadyPlayerIds,
      createdAt: this.state.createdAt,
      lastActivityAt: this.state.lastActivityAt,
      expiresAt: this.state.expiresAt,
      viewerPlayerId: playerId,
    };
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

  private domainError(e: unknown) {
    if (e instanceof DomainError) {
      return this.errorRes(e.code, e.message, domainStatus(e.code));
    }
    console.error("Unexpected:", e);
    return this.errorRes("INTERNAL_ERROR", "内部错误", 500);
  }

  private domainErrorToJson(e: unknown, commandId: string, version: number) {
    if (e instanceof DomainError) {
      return this.jsonRes({
        success: false,
        error: { code: e.code, message: e.message },
        commandId,
        version,
      }, domainStatus(e.code));
    }
    return this.jsonRes({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "内部错误" },
      commandId,
      version,
    }, 500);
  }
}

function domainStatus(code: DomainErrorCode): number {
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

async function reqJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}
