// ─── Cloudflare Worker 入口 ───
// WebSocket 由 Worker 直接处理，DO 只做状态存储

import { Room } from "../room/room.js";
import { errorResponse, jsonResponse } from "./responses.js";
import { isValidName } from "../shared/validation.js";
import { generateRoomCode, computeExpiresAt, isExpired } from "../room/engine.js";
import {
  generatePlayerToken,
  hashToken,
  signTicket,
  verifyTicket,
  type SocketTicketClaims,
} from "./auth.js";
import type { RoomState, PublicCause } from "../shared/domain.js";
import type { ServerMessage, CommandError } from "../shared/protocol.js";

export { Room };
export type { SocketTicketClaims };

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  WS_TICKET_SECRET: string;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

// In-memory WebSocket tracking (per-Worker instance)
type WsConn = { ws: WebSocket; playerId: string; roomCode: string };
const connections = new Map<WebSocket, WsConn>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // WebSocket upgrade：/api/rooms/{code}/socket 路径判断
    // ⚠️ Cloudflare edge strips Upgrade header before reaching Worker
    const wsMatch = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/socket$/);
    if (wsMatch) {
      return handleWebSocket(request, env, wsMatch[1]!);
    }

    // POST /api/rooms → 创建房间
    if (path === "/api/rooms" && method === "POST") {
      return handleCreateRoom(request, env);
    }

    // /api/rooms/{code}/* → 转发到 DO
    const roomMatch = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})(\/.*)?$/);
    if (roomMatch) {
      const roomCode = roomMatch[1]!;
      const doUrl = `https://do${roomMatch[2] || ""}`;
      const objectId = env.ROOMS.idFromName(roomCode);
      const room = env.ROOMS.get(objectId);
      const doRequest = new Request(doUrl, {
        method: request.method,
        headers: request.headers,
        body: method !== "GET" ? request.body : undefined,
      });
      return room.fetch(doRequest);
    }

    // /api/* 404
    if (path.startsWith("/api/")) {
      return errorResponse("ROOM_NOT_FOUND", "未知 API 端点", 404, crypto.randomUUID());
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};

// ─── WebSocket 处理 ───

async function handleWebSocket(request: Request, env: Env, roomCode: string): Promise<Response> {
  const url = new URL(request.url);
  const ticket = url.searchParams.get("ticket") || "";

  // 验证 ticket
  const secret = env.WS_TICKET_SECRET;
  if (!secret) return new Response("missing WS_TICKET_SECRET", { status: 500 });
  const claims = await verifyTicket(secret, ticket);
  if (!claims || claims.roomCode !== roomCode) {
    let debug = `ticket invalid. secret_len=${secret.length}`;
    if (claims) debug += ` claims_room=${claims.roomCode} vs ${roomCode} expires=${claims.expiresAt} now=${Date.now()}`;
    return new Response(debug, { status: 401 });
  }

  const playerId = claims.playerId;

  // 创建 WebSocket
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // 接受服务端
  server.accept();

  // 记录连接
  connections.set(server, { ws: server, playerId, roomCode });

  // 获取房间状态并发送 snapshot
  try {
    const doState = await getRoomState(env, roomCode);
    if (doState) {
      const presence = new Map<string, boolean>();
      for (const [, conn] of connections) {
        if (conn.roomCode === roomCode) presence.set(conn.playerId, true);
      }
      const view = toPublicViewSimple(doState, playerId, presence);
      const snapshotMsg: ServerMessage = {
        type: "room.snapshot",
        version: doState.version,
        state: view,
      };
      server.send(JSON.stringify(snapshotMsg));

      // 广播玩家加入
      const cause: PublicCause = { type: "player.joined", playerId };
      broadcastToRoom(roomCode, playerId, doState.version, cause, env);
    }
  } catch (e) {
    console.error("snapshot error:", e);
  }

  // 设置消息处理
  server.addEventListener("message", async (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);
      await handleWsMessage(server, msg, env);
    } catch (e) {
      console.error("ws msg error:", e);
    }
  });

  server.addEventListener("close", () => {
    connections.delete(server);
    const conn = connections.get(server);
    if (conn) {
      broadcastToRoom(conn.roomCode, conn.playerId, 0, undefined, env);
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

// ─── WebSocket 消息处理 ───

async function handleWsMessage(
  ws: WebSocket,
  rawMsg: { type: string; commandId: string; expectedVersion: number; payload: unknown },
  env: Env,
) {
  const conn = connections.get(ws);
  if (!conn) return;

  const { roomCode, playerId } = conn;
  const { type, commandId, expectedVersion, payload } = rawMsg;
  const doUrl = `https://do/api/rooms/${roomCode}/command`;

  try {
    const resp = await fetchDO(env, roomCode, `/command`, {
      method: "POST",
      body: JSON.stringify({
        action: type,
        commandId,
        expectedVersion,
        payload,
        playerId,
      }),
    });

    const result = await resp.json() as {
      success: boolean;
      error?: { code: string; message: string };
      version?: number;
      cause?: PublicCause;
    };

    if (result.success) {
      // 广播状态更新
      const cause = result.cause;
      const version = result.version || 0;
      broadcastToRoom(roomCode, playerId, version, cause, env);
    } else {
      // 发送错误
      const errMsg: CommandError = {
        type: "command.error",
        commandId,
        code: (result.error?.code as CommandError["code"]) || "COMMAND_REJECTED",
        message: result.error?.message || "未知错误",
        currentVersion: result.version || 0,
      };
      if (ws.readyState === WebSocket.READY_STATE_OPEN) {
        ws.send(JSON.stringify(errMsg));
      }
    }
  } catch (e) {
    console.error("command error:", e);
  }
}

// ─── 广播 ───

async function broadcastToRoom(
  roomCode: string,
  senderPlayerId: string,
  version: number,
  cause: PublicCause | undefined,
  env: Env,
) {
  const state = await getRoomState(env, roomCode);
  if (!state) return;

  const presence = new Map<string, boolean>();
  const roomConns: WsConn[] = [];

  for (const [, conn] of connections) {
    if (conn.roomCode === roomCode) {
      presence.set(conn.playerId, true);
      roomConns.push(conn);
    }
  }

  for (const conn of roomConns) {
    if (conn.ws.readyState !== WebSocket.READY_STATE_OPEN) continue;

    const view = toPublicViewSimple(state, conn.playerId, presence);
    const msg: ServerMessage = cause
      ? { type: "room.updated", version: state.version, cause, state: view }
      : { type: "room.snapshot", version: state.version, state: view };

    try {
      conn.ws.send(JSON.stringify(msg));
    } catch { /* connection closed */ }
  }
}

// ─── 获取房间状态 ───

async function getRoomState(env: Env, roomCode: string): Promise<RoomState | null> {
  const resp = await fetchDO(env, roomCode, `/state`, { method: "GET" });
  if (!resp.ok) return null;
  const data = await resp.json() as { state: RoomState | null };
  return data.state || null;
}

// ─── DO fetch 辅助 ───

async function fetchDO(
  env: Env,
  roomCode: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const objectId = env.ROOMS.idFromName(roomCode);
  const room = env.ROOMS.get(objectId);
  return room.fetch(new Request(`https://do${path}`, init));
}

// ─── 简单公开视图 ───

function toPublicViewSimple(
  state: RoomState,
  viewerPlayerId: string | null,
  presence: Map<string, boolean>,
) {
  const gameEnded = state.phase === "finished";
  return {
    roomCode: state.roomCode,
    phase: state.phase,
    version: state.version,
    players: state.players.map((p) => ({
      id: p.id,
      seat: p.seat,
      name: p.name,
      ready: p.ready,
      connected: presence.get(p.id) ?? false,
      secret: gameEnded || p.id === viewerPlayerId ? p.secret : null,
    })),
    currentGame: state.currentGame,
    completedGames: state.completedGames.map((g) => ({
      gameNumber: g.gameNumber,
      firstPlayerId: g.firstPlayerId,
      currentPlayerId: g.currentPlayerId,
      winnerPlayerId: g.winnerPlayerId,
      loserPlayerId: g.loserPlayerId,
      startedAt: g.startedAt,
      finishedAt: g.finishedAt,
      turns: g.turns,
    })),
    previousLoserId: state.previousLoserId,
    rematchReadyPlayerIds: state.rematchReadyPlayerIds,
    createdAt: state.createdAt,
    lastActivityAt: state.lastActivityAt,
    expiresAt: state.expiresAt,
    viewerPlayerId,
  };
}

// ─── 创建房间 ───

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);

  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name : "";
    if (!isValidName(name)) {
      return errorResponse("INVALID_NAME", "昵称 1~16 个可见字符", 400, requestId);
    }

    for (let attempt = 0; attempt < 10; attempt++) {
      const roomCode = generateRoomCode();
      const token = generatePlayerToken();
      const tokenHash = await hashToken(token);

      const resp = await fetchDO(env, roomCode, "/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, tokenHash }),
      });

      if (resp.ok) {
        const data = await resp.json() as { playerId: string };
        return jsonResponse({
          roomCode,
          playerToken: token,
          playerId: data.playerId,
          roomUrl: `${url.protocol}//${url.host}/r/${roomCode}`,
        }, 201);
      }

      const err = await resp.json().catch(() => null) as { error?: { code: string } };
      if (err?.error?.code !== "ALREADY_EXISTS") {
        return jsonResponse(err, resp.status);
      }
    }
    return errorResponse("INTERNAL_ERROR", "无法创建房间", 500, requestId);
  } catch (err) {
    console.error("Create error:", err);
    return errorResponse("INTERNAL_ERROR", "创建失败", 500, requestId);
  }
}
