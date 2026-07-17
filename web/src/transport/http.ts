// ─── HTTP Transport（短轮询） ───

import type { DomainErrorCode } from "../../../src/shared/protocol.js";
import type { PublicRoomView } from "../../../src/shared/domain.js";

type Handler = {
  onState: (state: PublicRoomView) => void;
  onError: (code: DomainErrorCode, message: string) => void;
};

const API_BASE = "/api";

export class GameTransport {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private lastVersion = -1;
  private playerToken: string;
  private roomCode: string;
  private handler: Handler;
  private closed = false;
  private inFlight = false;
  private paused = false;

  constructor(roomCode: string, playerToken: string, handler: Handler) {
    this.roomCode = roomCode;
    this.playerToken = playerToken;
    this.handler = handler;
  }

  async connect(): Promise<void> {
    const state = await this.fetchState();
    if (state) {
      this.lastVersion = state.version;
      this.handler.onState(state);
    }

    // 轮询
    this.pollTimer = setInterval(() => this.poll(), 1500);

    // 页面隐藏时暂停轮询
    this.visibilityHandler = () => {
      this.paused = document.hidden;
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private async poll(): Promise<void> {
    if (this.closed || this.inFlight || this.paused) return;
    this.inFlight = true;
    try {
      const state = await this.fetchState();
      if (state && state.version > this.lastVersion) {
        this.lastVersion = state.version;
        this.handler.onState(state);
      }
    } finally {
      this.inFlight = false;
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
        cause?: unknown;
        error?: { code: DomainErrorCode; message: string };
        version?: number;
      };
      if (!result.success && result.error) {
        this.handler.onError(result.error.code, result.error.message);
      }
      // 立即拉取最新状态
      const state = await this.fetchState();
      if (state && state.version > this.lastVersion) {
        this.lastVersion = state.version;
        this.handler.onState(state);
      }
    } catch {
      // 静默处理网络错误，轮询会自动恢复
    }
  }

  disconnect(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }
}
