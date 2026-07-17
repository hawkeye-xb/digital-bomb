// ─── Cloudflare Worker 入口 ───

import { Room } from "../room/room.js";
import { errorResponse } from "./responses.js";
import { isValidName } from "../shared/validation.js";
import { generateRoomCode } from "../room/engine.js";
import { jsonResponse } from "./responses.js";

export { Room };
export type { SocketTicketClaims } from "./auth.js";

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

    // /api/rooms/{code}/... → 转发到 DO
    const roomMatch = path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})(\/.*)?$/);
    if (roomMatch) {
      const roomCode = roomMatch[1]!;
      const objectId = env.ROOMS.idFromName(roomCode);
      const room = env.ROOMS.get(objectId);

      // WebSocket upgrade：转发原始请求（不重建，保留升级属性）
      const isWs = request.headers.get("Upgrade") === "websocket";
      if (isWs) {
        // DO 不关心 URL path，但 Upgrade header 必须保留
        const wsUrl = new URL(request.url);
        wsUrl.protocol = "https:";
        wsUrl.hostname = "do";
        const wsRequest = new Request(wsUrl, request);
        return room.fetch(wsRequest);
      }

      // HTTP 请求：重写 URL 发给 DO
      const doUrl = new URL(`https://do${roomMatch[2] || ""}`);
      const doRequest = new Request(doUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return room.fetch(doRequest);
    }

    // /api/* 404
    if (path.startsWith("/api/")) {
      return errorResponse("ROOM_NOT_FOUND", "未知 API 端点", 404, crypto.randomUUID());
    }

    // 静态资源
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);

  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name : "";

    if (!isValidName(name)) {
      return errorResponse("INVALID_NAME", "昵称 1~16 个可见字符", 400, requestId);
    }

    // 生成唯一房间码
    let roomCode = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      roomCode = generateRoomCode();
      const objectId = env.ROOMS.idFromName(roomCode);
      const room = env.ROOMS.get(objectId);

      // 尝试初始化
      const initRequest = new Request(`https://do/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      const resp = await room.fetch(initRequest);
      if (resp.ok) {
        const data = await resp.json() as { playerToken: string; playerId: string };
        return jsonResponse({
          roomCode,
          playerToken: data.playerToken,
          playerId: data.playerId,
          roomUrl: `${url.protocol}//${url.host}/r/${roomCode}`,
        }, 201);
      }

      const err = await resp.json().catch(() => null) as { error?: { code?: string } } | null;
      if (err?.error?.code !== "ALREADY_EXISTS") {
        return jsonResponse(err, resp.status);
      }
    }

    return errorResponse("INTERNAL_ERROR", "无法创建房间，请重试", 500, requestId);
  } catch (err) {
    console.error("Create room error:", err);
    return errorResponse("INTERNAL_ERROR", "创建房间失败", 500, requestId);
  }
}
