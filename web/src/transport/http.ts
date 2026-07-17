// ─── HTTP Transport（替代 WebSocket 的短轮询） ───

import type {
  RoomSnapshot,
  RoomUpdated,
  ServerMessage,
  DomainErrorCode,
} from "../../../src/shared/protocol.js";
import type { PublicRoomView } from "../../../src/shared/domain.js";

type Handler = {
  onState: (state: PublicRoomView) => void;
  onError: (code: DomainErrorCode, message: string) => void;
};

const API_BASE = "/api";

export class GameTransport {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastVersion = -1;
  private playerToken: string;
  private roomCode: string;
  private handler: Handler;
  private closed = false;

  constructor(roomCode: string, playerToken: string, handler: Handler) {
    this.roomCode = roomCode;
    this.playerToken = playerToken;
    this.handler = handler;
  }

  async connect(): Promise<void> {
    // 首次加载状态
    const state = await this.fetchState();
    if (state) {
      this.lastVersion = state.version;
      this.handler.onState(state);
    }

    // 开始轮询（1.5 秒间隔）
    this.pollTimer = setInterval(() => this.poll(), 1500);
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    const state = await this.fetchState();
    if (state && state.version !== this.lastVersion) {
      this.lastVersion = state.version;
      this.handler.onState(state);
    }
  }

  private async fetchState(): Promise<PublicRoomView | null> {
    try {
      const resp = await fetch(`${API_BASE}/rooms/${this.roomCode}/state`, {
        headers: { Authorization: `Bearer ${this.playerToken}` },
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { state: PublicRoomView | null };
      return data.state || null;
    } catch {
      return null;
    }
  }

  async sendCommand(type: string, payload: unknown, expectedVersion: number): Promise<void> {
    try {
      const resp = await fetch(`${API_BASE}/rooms/${this.roomCode}/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.playerToken}`,
        },
        body: JSON.stringify({
          type,
          commandId: crypto.randomUUID(),
          expectedVersion,
          payload,
        }),
      });
      const result = await resp.json() as {
        success?: boolean;
        error?: { code: DomainErrorCode; message: string };
      };
      if (!result.success && result.error) {
        this.handler.onError(result.error.code, result.error.message);
      }
      // 立即拉取最新状态
      const state = await this.fetchState();
      if (state && state.version !== this.lastVersion) {
        this.lastVersion = state.version;
        this.handler.onState(state);
      }
    } catch {
      this.handler.onError("INTERNAL_ERROR" as DomainErrorCode, "网络错误");
    }
  }

  disconnect(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
