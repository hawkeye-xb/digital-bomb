// ─── Cloudflare Worker — Worker handles WebSocket, DO is state store ───

import { Room } from "../room/room.js";
import { errorResponse, jsonResponse } from "./responses.js";
import { isValidName } from "../shared/validation.js";
import { generateRoomCode } from "../room/engine.js";
import { generatePlayerToken, hashToken, verifyTicket } from "./auth.js";
import type { RoomState, PublicCause } from "../shared/domain.js";
import type { ServerMessage, CommandError } from "../shared/protocol.js";

export { Room };

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  WS_TICKET_SECRET: string;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

// Per-worker WebSocket connections
type Conn = { ws: WebSocket; playerId: string; roomCode: string };
const connections = new Map<WebSocket, Conn>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // WebSocket: /api/rooms/{code}/socket — Worker handles directly
    const wsMatch = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/socket$/);
    if (wsMatch) {
      return handleWebSocket(request, env, wsMatch[1]!);
    }

    if (path === "/api/rooms" && method === "POST") {
      return handleCreateRoom(request, env);
    }

    // Other API → forward to DO
    const roomMatch = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})(\/.*)?$/);
    if (roomMatch) {
      const roomCode = roomMatch[1]!;
      const doUrl = new URL(`https://do${roomMatch[2] || ""}`);
      doUrl.search = url.search;
      const obj = env.ROOMS.get(env.ROOMS.idFromName(roomCode));
      return obj.fetch(new Request(doUrl, { method, headers: request.headers, body: method !== "GET" ? request.body : undefined }));
    }

    if (path.startsWith("/api/")) return errorResponse("ROOM_NOT_FOUND", "", 404, crypto.randomUUID());
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};

async function handleWebSocket(request: Request, env: Env, roomCode: string): Promise<Response> {
  const ticket = new URL(request.url).searchParams.get("ticket") || "";
  const secret = env.WS_TICKET_SECRET;
  if (!secret) return new Response("no secret", { status: 500 });
  const claims = await verifyTicket(secret, ticket);
  if (!claims || claims.roomCode !== roomCode)
    return new Response("invalid ticket", { status: 401 });
  return new Response(`ok player=${claims.playerId}`, { status: 200 });
}

async function handleWsMsg(ws: WebSocket, raw: { type: string; commandId: string; expectedVersion: number; payload: unknown }, env: Env) {
  const conn = connections.get(ws);
  if (!conn) return;
  const { roomCode, playerId } = conn;

  const resp = await fetchDO(env, roomCode, "/command", {
    method: "POST",
    body: JSON.stringify({ ...raw, playerId }),
  });

  const result = await resp.json() as { success?: boolean; cause?: PublicCause; error?: { code: string; message: string }; version?: number };
  if (result.success && result.cause) {
    const st = await getRoomState(env, roomCode);
    if (st) broadcast(env, roomCode, st, result.cause);
  } else if (result.error) {
    const errMsg: CommandError = { type: "command.error", commandId: raw.commandId, code: result.error.code as CommandError["code"], message: result.error.message, currentVersion: result.version || 0 };
    try { ws.send(JSON.stringify(errMsg)); } catch { /* */ }
  }
}

async function getRoomState(env: Env, roomCode: string): Promise<RoomState | null> {
  const r = await fetchDO(env, roomCode, "/state", { method: "GET" });
  if (!r.ok) return null;
  const d = await r.json() as { state: RoomState | null };
  return d.state || null;
}

async function broadcast(env: Env, roomCode: string, state: RoomState, cause: PublicCause) {
  const presence = new Map<string, boolean>();
  for (const [, c] of connections) if (c.roomCode === roomCode) presence.set(c.playerId, true);

  for (const [, c] of connections) {
    if (c.roomCode !== roomCode) continue;
    const v = publicView(state, c.playerId, presence);
    const msg: ServerMessage = { type: "room.updated", version: state.version, cause, state: v };
    try { c.ws.send(JSON.stringify(msg)); } catch { connections.delete(c.ws); }
  }
}

function sendSnapshot(ws: WebSocket, state: RoomState, playerId: string, roomCode: string) {
  const presence = new Map<string, boolean>();
  for (const [, c] of connections) if (c.roomCode === roomCode) presence.set(c.playerId, true);
  const v = publicView(state, playerId, presence);
  const msg: ServerMessage = { type: "room.snapshot", version: state.version, state: v };
  try { ws.send(JSON.stringify(msg)); } catch { /* */ }
}

function publicView(state: RoomState, pid: string | null, presence: Map<string, boolean>) {
  const ge = state.phase === "finished";
  return {
    roomCode: state.roomCode, phase: state.phase, version: state.version,
    players: state.players.map(p => ({ id: p.id, seat: p.seat, name: p.name, ready: p.ready, connected: presence.get(p.id) ?? false, secret: ge || p.id === pid ? p.secret : null })),
    currentGame: state.currentGame,
    completedGames: state.completedGames.map(g => ({ gameNumber: g.gameNumber, firstPlayerId: g.firstPlayerId, currentPlayerId: g.currentPlayerId, winnerPlayerId: g.winnerPlayerId, loserPlayerId: g.loserPlayerId, startedAt: g.startedAt, finishedAt: g.finishedAt, turns: g.turns })),
    previousLoserId: state.previousLoserId, rematchReadyPlayerIds: state.rematchReadyPlayerIds,
    createdAt: state.createdAt, lastActivityAt: state.lastActivityAt, expiresAt: state.expiresAt, viewerPlayerId: pid,
  };
}

async function fetchDO(env: Env, code: string, path: string, init: RequestInit): Promise<Response> {
  return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(`https://do${path}`, init));
}

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const rid = crypto.randomUUID();
  const url = new URL(request.url);
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name : "";
    if (!isValidName(name)) return errorResponse("INVALID_NAME", "", 400, rid);
    for (let i = 0; i < 10; i++) {
      const code = generateRoomCode();
      const t = generatePlayerToken();
      const h = await hashToken(t);
      const r = await fetchDO(env, code, "/init", { method: "POST", body: JSON.stringify({ name, tokenHash: h, roomCode: code }) });
      if (r.ok) {
        const d = await r.json() as { playerId: string };
        return jsonResponse({ roomCode: code, playerToken: t, playerId: d.playerId, roomUrl: `${url.protocol}//${url.host}/r/${code}` }, 201);
      }
      const e = await r.json().catch(() => null) as { error?: { code: string } };
      if (e?.error?.code !== "ALREADY_EXISTS") return jsonResponse(e, r.status);
    }
    return errorResponse("INTERNAL_ERROR", "无法创建", 500, rid);
  } catch (e) {
    return errorResponse("INTERNAL_ERROR", "创建失败", 500, rid);
  }
}

// ─── Crypto helpers ───

async function sha1(msg: string): Promise<Uint8Array> {
  const d = new TextEncoder().encode(msg);
  const h = await crypto.subtle.digest("SHA-1", d);
  return new Uint8Array(h);
}

function hexToBase64(hex: Uint8Array): string {
  return btoa(String.fromCharCode(...hex));
}
