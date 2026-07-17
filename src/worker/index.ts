// ─── Cloudflare Worker — 纯路由，DO 处理一切（含 WebSocket） ───

import { Room } from "../room/room.js";
import { errorResponse, jsonResponse } from "./responses.js";
import { isValidName } from "../shared/validation.js";
import { generateRoomCode } from "../room/engine.js";
import { generatePlayerToken, hashToken } from "./auth.js";

export { Room };

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  WS_TICKET_SECRET: string;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // WebSocket: 转发 ticket 和 roomCode 给 DO，DO 内部处理 WS 升级
    const wsMatch = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/socket$/);
    if (wsMatch) {
      const ticket = url.searchParams.get("ticket") || "";
      const roomCode = wsMatch[1]!;
      // 用 POST 请求传给 DO（避免 CF 剥离 Upgrade header）
      return env.ROOMS.get(env.ROOMS.idFromName(roomCode)).fetch(
        new Request("https://do/socket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket }),
        })
      );
    }

    if (path === "/api/rooms" && method === "POST") {
      return handleCreateRoom(request, env);
    }

    // Other API → forward to DO
    const roomMatch = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})(\/.*)?$/);
    if (roomMatch) {
      const doUrl = new URL(`https://do${roomMatch[2] || ""}`);
      doUrl.search = url.search;
      return env.ROOMS
        .get(env.ROOMS.idFromName(roomMatch[1]!))
        .fetch(new Request(doUrl, { method, headers: request.headers, body: method !== "GET" ? request.body : undefined }));
    }

    if (path.startsWith("/api/")) return errorResponse("ROOM_NOT_FOUND", "", 404, crypto.randomUUID());
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};

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
      const r = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(
        new Request("https://do/init", {
          method: "POST",
          body: JSON.stringify({ name, tokenHash: h, roomCode: code }),
        })
      );
      if (r.ok) {
        const d = await r.json() as { playerId: string };
        return jsonResponse(
          { roomCode: code, playerToken: t, playerId: d.playerId, roomUrl: `${url.protocol}//${url.host}/r/${code}` },
          201
        );
      }
      const e = await r.json().catch(() => null) as { error?: { code: string } };
      if (e?.error?.code !== "ALREADY_EXISTS") return jsonResponse(e, r.status);
    }
    return errorResponse("INTERNAL_ERROR", "无法创建", 500, rid);
  } catch (e) {
    return errorResponse("INTERNAL_ERROR", "创建失败", 500, rid);
  }
}
