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

    // WebSocket: Worker 验证 ticket，传 playerId 给 DO
    // 注意：DO 返回的 101+webSocket 无法通过 stub.fetch() 转发（1101）
    // 因此当前仍使用 HTTP 轮询。未来可让客户端直连 DO 的 wss 端点。
    const wsMatch = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/socket$/);
    if (wsMatch) {
      return errorResponse("NOT_IMPLEMENTED", "WebSocket 暂不可用，请刷新页面", 503, crypto.randomUUID());
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
