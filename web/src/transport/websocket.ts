// ─── WebSocket Transport ───

import type {
  ServerMessage,
  RoomSnapshot,
  RoomUpdated,
  CommandError,
  ClientCommand,
} from "../../../src/shared/protocol.js";
import type { PublicRoomView, PublicCause } from "../../../src/shared/domain.js";

type MessageHandler = {
  onSnapshot: (msg: RoomSnapshot) => void;
  onUpdated: (msg: RoomUpdated) => void;
  onExpired: () => void;
  onError: (msg: CommandError) => void;
  onClose: () => void;
};

export class GameTransport {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private maxRetryDelay = 15000;
  private url: string;
  private playerToken: string;
  private roomCode: string;
  private handler: MessageHandler;

  constructor(
    baseUrl: string,
    roomCode: string,
    playerToken: string,
    handler: MessageHandler,
  ) {
    this.url = baseUrl;
    this.roomCode = roomCode;
    this.playerToken = playerToken;
    this.handler = handler;
  }

  async connect(): Promise<void> {
    this.cleanup();
    try {
      const ticket = await this.getTicket();
      const wsUrl = this.url
        .replace("https://", "wss://")
        .replace("http://", "ws://");
      const connUrl = `${wsUrl}/api/rooms/${this.roomCode}/socket?ticket=${encodeURIComponent(ticket)}`;

      this.ws = new WebSocket(connUrl);

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as ServerMessage;
        switch (msg.type) {
          case "room.snapshot":
            this.handler.onSnapshot(msg);
            break;
          case "room.updated":
            this.handler.onUpdated(msg);
            break;
          case "room.expired":
            this.handler.onExpired();
            break;
          case "command.error":
            this.handler.onError(msg);
            break;
        }
      };

      this.ws.onclose = () => {
        if (this.reconnectTimer === null) {
          this.handler.onClose();
          this.retry();
        }
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };

      // 等待连接建立
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 10000);
        const onOpen = () => { clearTimeout(timeout); resolve(); };
        if (this.ws!.readyState === WebSocket.OPEN) onOpen();
        else this.ws!.addEventListener("open", onOpen, { once: true });
      });

      this.retryDelay = 1000;
    } catch (err) {
      console.error("WebSocket connect failed:", err);
      this.retry();
    }
  }

  private async getTicket(): Promise<string> {
    const resp = await fetch(
      `${this.url}/api/rooms/${this.roomCode}/socket-ticket`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.playerToken}` },
      },
    );
    if (!resp.ok) {
      throw new Error(`Ticket fetch failed: ${resp.status}`);
    }
    const data = (await resp.json()) as { ticket: string };
    return data.ticket;
  }

  private retry(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
      this.connect();
    }, this.retryDelay);
  }

  send<T extends string, P>(
    msg: ClientCommand<T, P>,
  ): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}
