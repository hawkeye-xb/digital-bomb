// ─── HTTP 响应工具 ───

import type { DomainErrorCode } from "../shared/protocol.js";

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function errorResponse(
  code: DomainErrorCode,
  message: string,
  status: number,
  requestId: string,
): Response {
  return jsonResponse(
    {
      error: { code, message },
      requestId,
    },
    status,
  );
}
