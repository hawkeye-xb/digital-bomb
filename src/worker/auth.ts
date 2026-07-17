// ─── 身份认证：长期 token + 短时 WebSocket ticket ───

export type SocketTicketClaims = {
  roomCode: string;
  playerId: string;
  expiresAt: number;
  nonce: string;
};

// ─── 生成随机 token（128 bits = 16 bytes, hex 编码） ───

export function generatePlayerToken(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── SHA-256 hash ───

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

// ─── 签发短时 WebSocket ticket ───

export async function signTicket(
  secret: string,
  claims: SocketTicketClaims,
): Promise<string> {
  const payload = JSON.stringify(claims);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const combined = `${btoa(payload)}.${sigHex}`;
  return btoa(combined);
}

// ─── 验证 WebSocket ticket ───

export async function verifyTicket(
  secret: string,
  ticket: string,
): Promise<SocketTicketClaims | null> {
  try {
    const combined = atob(ticket);
    const dotIdx = combined.lastIndexOf(".");
    if (dotIdx < 0) return null;

    const payloadB64 = combined.slice(0, dotIdx);
    const sigHex = combined.slice(dotIdx + 1);

    const payload = atob(payloadB64);
    const claims = JSON.parse(payload) as SocketTicketClaims;

    // 检查过期
    if (Date.now() > claims.expiresAt) return null;

    // 验证签名
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      hexToBytes(sigHex),
      new TextEncoder().encode(payload),
    );
    return ok ? claims : null;
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
