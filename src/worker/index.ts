// ─── Cloudflare Worker 入口（精简版：纯路由） ───

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

    // POST /api/rooms → 创建房间
    if (path === "/api/rooms" && method === "POST") {
      return handleCreateRoom(request, env);
    }

    // /api/rooms/{code}/* → 全部转发到 DO
    const roomMatch = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})(\/.*)?$/);
    if (roomMatch) {
      const roomCode = roomMatch[1]!;
      const objectId = env.ROOMS.idFromName(roomCode);
      const room = env.ROOMS.get(objectId);
      const doUrl = new URL(`https://do${roomMatch[2] || ""}`);
      doUrl.search = url.search;
      const doRequest = new Request(doUrl, { method, headers: request.headers, body: method !== "GET" ? request.body : undefined });
      return room.fetch(doRequest);
    }

    if (path.startsWith("/api/")) {
      return errorResponse("ROOM_NOT_FOUND", "未知 API 端点", 404, crypto.randomUUID());
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name : "";
    if (!isValidName(name)) return errorResponse("INVALID_NAME", "昵称 1~16 个可见字符", 400, requestId);

    for (let attempt = 0; attempt < 10; attempt++) {
      const roomCode = generateRoomCode();
      const token = generatePlayerToken();
      const tokenHash = await hashToken(token);
      const objectId = env.ROOMS.idFromName(roomCode);
      const room = env.ROOMS.get(objectId);
      const resp = await room.fetch(new Request("https://do/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, tokenHash, roomCode }),
      }));
      if (resp.ok) {
        const data = await resp.json() as { playerId: string };
        return jsonResponse({
          roomCode, playerToken: token, playerId: data.playerId,
          roomUrl: `${url.protocol}//${url.host}/r/${roomCode}`,
        }, 201);
      }
      const err = await resp.json().catch(() => null) as { error?: { code: string } };
      if (err?.error?.code !== "ALREADY_EXISTS") return jsonResponse(err, resp.status);
    }
    return errorResponse("INTERNAL_ERROR", "无法创建房间", 500, requestId);
  } catch (err) {
    console.error("Create error:", err);
    return errorResponse("INTERNAL_ERROR", "创建失败", 500, requestId);
  }
}
