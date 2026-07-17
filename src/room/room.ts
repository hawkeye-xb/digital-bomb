// ─── Room Durable Object — HTTP + WebSocket ───

import { DurableObject } from "cloudflare:workers";
import type { RoomState, PublicCause, PublicPlayer, PublicGame } from "../shared/domain.js";
import type { ServerMessage } from "../shared/protocol.js";
import type { DomainErrorCode } from "../shared/protocol.js";
import { DomainError, isValidName, isValidGuess } from "../shared/validation.js";
import {
  initializeRoomState, createPlayer, addPlayer,
  readySet, readyUnset, submitGuess, rematchSet, isExpired,
} from "./engine.js";
import { loadState, saveState, deleteAllState } from "./storage.js";

type SocketAttachment = { playerId: string; connectedAt: number };

export interface RoomEnv { WS_TICKET_SECRET: string; }

export class Room extends DurableObject<RoomEnv> {
  private state: RoomState | null = null;
  private loaded = false;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    await this.load();

    // WebSocket: path 以 /socket 结尾
    // Worker 自己处理 WebSocket，DO 只做 HTTP API
    if (path.endsWith("/socket")) {
      return new Response("use wss via Worker", { status: 400 });
    }

    if (path.endsWith("/init") && request.method === "POST") return this.handleInit(request);
    if (path.endsWith("/join") && request.method === "POST") return this.handleJoin(request);
    if (path.endsWith("/socket-ticket") && request.method === "POST") return this.handleTicket(request);
    if (path.endsWith("/state") && request.method === "GET") return this.jsonRes({ state: this.state });
    if (path.endsWith("/command") && request.method === "POST") return this.handleCommand(request);

    return this.errorRes("ROOM_NOT_FOUND", "未知操作", 404);
  }

  // ─── Init / Join / Ticket ───

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
    return this.jsonRes({ playerId: player.id });
  }

  private async handleJoin(request: Request): Promise<Response> {
    if (!this.state) return this.roomNotFound();
    const body = await reqJson(request);
    const name = String(body?.name || "");
    const tokenHash = String(body?.tokenHash || "");
    if (!isValidName(name)) return this.errorRes("INVALID_NAME", "昵称不合法", 400);

    const existing = this.state.players.find(p => p.tokenHash === tokenHash);
    if (existing) return this.jsonRes({ playerId: existing.id, playerToken: "", roomState: this.publicView(existing.id) });
    if (this.state.players.length >= 2) return this.errorRes("ROOM_FULL", "房间已满", 409);

    const { generatePlayerToken, hashToken } = await import("../worker/auth.js");
    const playerId = crypto.randomUUID();
    const token = generatePlayerToken();
    const hash = await hashToken(token);
    const player = createPlayer(playerId, name, hash, 2);
    try { this.state = addPlayer(this.state, player, Date.now()); } catch (e) { return this.domainError(e); }
    await this.persist();
    return this.jsonRes({ playerId, playerToken: token, roomState: this.publicView(playerId) });
  }

  private async handleTicket(request: Request): Promise<Response> {
    if (!this.state) return this.roomNotFound();
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return this.errorRes("UNAUTHORIZED", "缺少凭证", 401);
    const { hashToken } = await import("../worker/auth.js");
    const th = await hashToken(token);
    const player = this.state.players.find(p => p.tokenHash === th);
    if (!player) return this.errorRes("UNAUTHORIZED", "凭证无效", 401);
    const { signTicket } = await import("../worker/auth.js");
    const secret = this.env.WS_TICKET_SECRET;
    if (!secret) return this.errorRes("INTERNAL_ERROR", "missing secret", 500);
    const claims = { roomCode: this.state.roomCode, playerId: player.id, expiresAt: Date.now() + 60000, nonce: crypto.randomUUID() };
    const ticketStr = await signTicket(secret, claims);
    return this.jsonRes({ ticket: ticketStr, expiresAt: claims.expiresAt });
  }

  // ─── Command (Worker→DO HTTP) ───

  private async handleCommand(request: Request): Promise<Response> {
    if (!this.state) return this.roomNotFound();
    const b = await reqJson(request);
    const { type, commandId, expectedVersion, payload, playerId } = b as {
      type: string; commandId: string; expectedVersion: number;
      payload: Record<string, unknown>; playerId: string;
    };

    try {
      switch (type) {
        case "ready.set": {
          const secret = String(payload?.secret || "");
          if (!isValidGuess(secret)) throw new DomainError("INVALID_SECRET", "密码不是四位数字");
          const { state } = readySet(this.state, playerId, secret, commandId, Date.now());
          this.state = state; await this.persist();
          const cause = state.phase === "playing" && state.currentGame
            ? { type: "game.started" as const, firstPlayerId: state.currentGame.firstPlayerId }
            : { type: "ready.changed" as const, playerId, ready: true };
          return this.jsonRes({ success: true, version: state.version, cause });
        }
        case "ready.unset": {
          const { state } = readyUnset(this.state, playerId, commandId, Date.now());
          this.state = state; await this.persist();
          return this.jsonRes({ success: true, version: state.version, cause: { type: "ready.changed" as const, playerId, ready: false } });
        }
        case "guess.submit": {
          const guess = String(payload?.guess || "");
          if (!isValidGuess(guess)) throw new DomainError("INVALID_GUESS", "猜测不是四位数字");
          const { state, hitResult } = submitGuess(this.state, playerId, guess, commandId, expectedVersion, Date.now());
          this.state = state; await this.persist();
          return this.jsonRes({ success: true, version: state.version, cause: { type: "guess.resolved" as const, playerId, guess, hits: hitResult.hits, won: hitResult.won } });
        }
        case "rematch.set": {
          const ready = Boolean(payload?.ready);
          const { state } = rematchSet(this.state, playerId, ready, commandId, Date.now());
          this.state = state; await this.persist();
          let cause: Record<string, unknown>;
          if (state.phase === "preparing" && state.completedGames.length > 0 && state.previousLoserId) {
            cause = { type: "game.reset", firstPlayerId: state.previousLoserId };
          } else {
            cause = { type: "rematch.changed", playerId, ready };
          }
          return this.jsonRes({ success: true, version: state.version, cause });
        }
        default:
          return this.errorRes("COMMAND_REJECTED", `未知命令: ${type}`, 400);
      }
    } catch (e) {
      return this.domainErrorToJson(e, commandId, this.state?.version || 0);
    }
  }

  // ─── WebSocket Upgrade ───

  private async handleWsUpgrade(request: Request): Promise<Response> {
    if (!this.state) return this.roomNotFound();

    // 从 URL query 或 body 提取 ticket
    let ticket = "";
    const url = new URL(request.url);
    ticket = url.searchParams.get("ticket") || "";
    if (!ticket && request.method === "POST") {
      try { const b = await reqJson(request); ticket = b?.ticket || ""; } catch { /* ignore */ }
    }
    if (!ticket) return this.errorRes("TICKET_INVALID", "missing ticket", 401);

    // 验证 ticket
    const { verifyTicket } = await import("../worker/auth.js");
    const secret = this.env.WS_TICKET_SECRET;
    if (!secret) return this.errorRes("INTERNAL_ERROR", "missing secret", 500);
    const claims = await verifyTicket(secret, ticket);
    if (!claims || claims.roomCode !== this.state.roomCode) {
      return this.errorRes("TICKET_INVALID", "ticket 无效或已过期", 401);
    }

    const player = this.state.players.find(p => p.id === claims.playerId);
    if (!player) return this.errorRes("UNAUTHORIZED", "玩家不在房间", 401);

    // 创建 WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 关闭旧连接
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        const a = ws.deserializeAttachment() as SocketAttachment | null;
        if (a?.playerId === player.id) ws.close(4001, "replaced");
      } catch { /* noop */ }
    }

    // 接受新连接
    this.ctx.acceptWebSocket(server as never);
    (server as WebSocket).serializeAttachment({ playerId: player.id, connectedAt: Date.now() } satisfies SocketAttachment);

    // 发送 snapshot
    const snapshot: ServerMessage = {
      type: "room.snapshot",
      version: this.state.version,
      state: this.publicView(player.id),
    };
    (server as WebSocket).send(JSON.stringify(snapshot));

    // 广播加入
    this.broadcastExcept(player.id, {
      type: "room.updated",
      version: this.state.version,
      cause: { type: "player.joined", playerId: player.id },
      state: this.publicView(player.id),
    });

    return new Response(null, { status: 101, webSocket: client as never });
  }

  // ─── WebSocket 消息 ───

  async webSocketMessage(ws: WebSocket, raw: string) {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att || !this.state) return;

    try {
      const msg = JSON.parse(raw);
      const { type, commandId, expectedVersion, payload } = msg;
      const pid = att.playerId;

      let result: { success: boolean; cause?: PublicCause | { type: string; firstPlayerId: string } } = { success: false };
      let err: Error | null = null;

      switch (type) {
        case "ready.set": {
          try { result = { success: true, cause: { type: "ready.changed" as const, playerId: pid, ready: true } };
            const { state } = readySet(this.state, pid, String(payload?.secret || ""), commandId, Date.now());
            this.state = state; await this.persist();
            if (state.phase === "playing" && state.currentGame)
              result.cause = { type: "game.started" as const, firstPlayerId: state.currentGame.firstPlayerId };
          } catch (e) { err = e as Error; } break;
        }
        case "ready.unset": {
          try { const { state } = readyUnset(this.state, pid, commandId, Date.now());
            this.state = state; await this.persist();
            result = { success: true, cause: { type: "ready.changed" as const, playerId: pid, ready: false } };
          } catch (e) { err = e as Error; } break;
        }
        case "guess.submit": {
          try { const { state, hitResult } = submitGuess(this.state, pid, String(payload?.guess || ""), commandId, expectedVersion, Date.now());
            this.state = state; await this.persist();
            result = { success: true, cause: { type: "guess.resolved" as const, playerId: pid, guess: String(payload?.guess || ""), hits: hitResult.hits, won: hitResult.won } };
          } catch (e) { err = e as Error; } break;
        }
        case "rematch.set": {
          try { const { state } = rematchSet(this.state, pid, Boolean(payload?.ready), commandId, Date.now());
            this.state = state; await this.persist();
            if (state.phase === "preparing" && state.completedGames.length > 0 && state.previousLoserId)
              result = { success: true, cause: { type: "game.reset" as const, firstPlayerId: state.previousLoserId } };
            else result = { success: true, cause: { type: "rematch.changed" as const, playerId: pid, ready: Boolean(payload?.ready) } };
          } catch (e) { err = e as Error; } break;
        }
        case "state.request": {
          const snap: ServerMessage = { type: "room.snapshot", version: this.state.version, state: this.publicView(pid) };
          try { ws.send(JSON.stringify(snap)); } catch { /* noop */ }
          return;
        }
      }

      if (err instanceof DomainError) {
        try {
          ws.send(JSON.stringify({ type: "command.error", commandId, code: err.code, message: err.message, currentVersion: this.state.version }));
        } catch { /* noop */ }
      } else if (err) {
        try {
          ws.send(JSON.stringify({ type: "command.error", commandId, code: "INTERNAL_ERROR", message: "内部错误", currentVersion: this.state?.version ?? 0 }));
        } catch { /* noop */ }
      } else if (result.success && result.cause) {
        this.broadcastToAll(result.cause);
      }
    } catch {
      try { ws.send(JSON.stringify({ type: "command.error", commandId: "", code: "INVALID_INPUT", message: "无效消息", currentVersion: this.state?.version ?? 0 })); } catch { /* noop */ }
    }
  }

  webSocketClose(ws: WebSocket) {
    this.broadcastToAll(undefined);
  }

  webSocketError(_ws: WebSocket, _err: unknown) {}

  // ─── Alarm ───

  async alarm(): Promise<void> {
    await this.load();
    if (!this.state) return;
    if (!isExpired(this.state, Date.now())) { await this.ctx.storage.setAlarm(this.state.expiresAt); return; }
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try { ws.send(JSON.stringify({ type: "room.expired" })); ws.close(4002, "expired"); } catch { /* noop */ }
    }
    await deleteAllState(this.ctx.storage);
  }

  // ─── 广播 ───

  private broadcastToAll(cause: PublicCause | undefined | { type: string; firstPlayerId: string } | { type: string; playerId: string; ready: boolean } | { type: string; playerId: string; guess: string; hits: number; won: boolean }) {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att) continue;
      const view = this.publicView(att.playerId);
      const msg: ServerMessage = cause
        ? { type: "room.updated", version: this.state!.version, cause: cause as PublicCause, state: view }
        : { type: "room.snapshot", version: this.state!.version, state: view };
      try { ws.send(JSON.stringify(msg)); } catch { /* noop */ }
    }
  }

  private broadcastExcept(excludeId: string, msg: ServerMessage) {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att || att.playerId === excludeId) continue;
      try { ws.send(JSON.stringify(msg)); } catch { /* noop */ }
    }
  }

  // ─── 辅助 ───

  private async load() { if (this.loaded) return; this.state = await loadState(this.ctx.storage); this.loaded = true; }
  private async persist() { if (!this.state) return; await saveState(this.ctx.storage, this.state); await this.ctx.storage.setAlarm(this.state.expiresAt); }
  private roomNotFound() { return this.errorRes("ROOM_NOT_FOUND", "房间不存在", 404); }

  private publicView(playerId: string | null) {
    if (!this.state) return null as never;
    const gameEnded = this.state.phase === "finished";
    const sockets = this.ctx.getWebSockets();
    const presence = new Map<string, boolean>();
    for (const ws of sockets) {
      try { const a = ws.deserializeAttachment() as SocketAttachment | null; if (a) presence.set(a.playerId, true); } catch { /* noop */ }
    }
    return {
      roomCode: this.state.roomCode, phase: this.state.phase, version: this.state.version,
      players: this.state.players.map(p => ({
        id: p.id, seat: p.seat, name: p.name, ready: p.ready,
        connected: presence.get(p.id) ?? false,
        secret: gameEnded || p.id === playerId ? p.secret : null,
      })),
      currentGame: this.state.currentGame,
      completedGames: this.state.completedGames.map(g => ({ gameNumber: g.gameNumber, firstPlayerId: g.firstPlayerId, currentPlayerId: g.currentPlayerId, winnerPlayerId: g.winnerPlayerId, loserPlayerId: g.loserPlayerId, startedAt: g.startedAt, finishedAt: g.finishedAt, turns: g.turns })),
      previousLoserId: this.state.previousLoserId, rematchReadyPlayerIds: this.state.rematchReadyPlayerIds,
      createdAt: this.state.createdAt, lastActivityAt: this.state.lastActivityAt, expiresAt: this.state.expiresAt,
      viewerPlayerId: playerId,
    };
  }

  private jsonRes(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } }); }
  private errorRes(code: DomainErrorCode, message: string, status: number, overrideCode?: string) { return this.jsonRes({ error: { code: overrideCode || code, message }, requestId: crypto.randomUUID() }, status); }
  private domainError(e: unknown) { if (e instanceof DomainError) return this.errorRes(e.code, e.message, domainStatus(e.code)); console.error(e); return this.errorRes("INTERNAL_ERROR", "内部错误", 500); }
}

function domainStatus(c: DomainErrorCode): number {
  switch (c) { case "ROOM_NOT_FOUND": return 404; case "UNAUTHORIZED": case "TICKET_INVALID": return 401; case "ROOM_FULL": return 409; case "VERSION_CONFLICT": return 409; default: return 400; }
}

async function reqJson(r: Request): Promise<Record<string, unknown> | null> {
  try { return await r.json() as Record<string, unknown>; } catch { return null; }
}
