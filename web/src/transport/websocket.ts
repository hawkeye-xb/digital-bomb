import type {
  CommandError,
  PresenceUpdated,
  ServerMessage,
} from "../../../src/shared/protocol.js";
import type {
  InteractionKind,
  PlayerActivity,
  PublicCause,
  PublicRoomView,
} from "../../../src/shared/domain.js";

export type ConnectionState = "connecting" | "connected" | "reconnecting";

type Handler = {
  onState: (state: PublicRoomView, cause?: PublicCause) => void;
  onPresence: (message: PresenceUpdated) => void;
  onInteraction: (fromPlayerId: string, interaction: InteractionKind) => void;
  onConnection: (state: ConnectionState) => void;
  onError: (code: CommandError["code"], message: string) => void;
  onExpired: () => void;
};

export class GameTransport {
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1_000;
  private stopped = false;
  private connecting: Promise<void> | null = null;
  private lastVersion = -1;

  constructor(
    private readonly baseUrl: string,
    private readonly roomCode: string,
    private readonly playerToken: string,
    private readonly handler: Handler,
  ) {}

  connect(): Promise<void> {
    this.stopped = false;
    if (!this.connecting) this.connecting = this.openSocket();
    return this.connecting;
  }

  sendCommand<T extends string, P>(type: T, payload: P, expectedVersion: number): void {
    this.send({ type, payload, expectedVersion, commandId: crypto.randomUUID() });
  }

  sendPresence(activity: PlayerActivity): void {
    this.send({ type: "presence.update", activity });
  }

  sendInteraction(interaction: InteractionKind): void {
    this.send({ type: "interaction.send", interaction });
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connecting = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, "leaving room");
    }
  }

  private async openSocket(): Promise<void> {
    this.handler.onConnection(this.lastVersion < 0 ? "connecting" : "reconnecting");
    try {
      const ticket = await this.getTicket();
      if (this.stopped) return;
      const wsBase = this.baseUrl.replace(/^http/, "ws");
      const socket = new WebSocket(
        `${wsBase}/api/rooms/${this.roomCode}/socket?ticket=${encodeURIComponent(ticket)}`,
      );
      this.socket = socket;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("连接超时")), 10_000);
        socket.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("连接失败"));
        };
      });

      if (this.stopped || socket !== this.socket) return;
      this.retryDelay = 1_000;
      this.handler.onConnection("connected");
      socket.onmessage = (event) => this.handleMessage(String(event.data));
      socket.onclose = () => this.handleClose(socket);
      socket.onerror = () => { /* onclose performs recovery */ };
    } catch {
      if (!this.stopped) this.scheduleRetry();
    } finally {
      this.connecting = null;
    }
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage;
    try { message = JSON.parse(raw) as ServerMessage; } catch { return; }

    switch (message.type) {
      case "room.snapshot":
        if (message.version >= this.lastVersion) {
          this.lastVersion = message.version;
          this.handler.onState(message.state);
        }
        break;
      case "room.updated":
        if (message.version > this.lastVersion) {
          this.lastVersion = message.version;
          this.handler.onState(message.state, message.cause);
        }
        break;
      case "presence.updated":
        this.handler.onPresence(message);
        break;
      case "interaction.received":
        this.handler.onInteraction(message.fromPlayerId, message.interaction);
        break;
      case "command.error":
        this.handler.onError(message.code, message.message);
        if (message.code === "VERSION_CONFLICT") {
          this.send({ type: "state.request", commandId: crypto.randomUUID(), expectedVersion: message.currentVersion, payload: {} });
        }
        break;
      case "room.expired":
        this.handler.onExpired();
        break;
    }
  }

  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    if (!this.stopped) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    this.handler.onConnection("reconnecting");
    const jitter = Math.floor(Math.random() * 300);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.retryDelay + jitter);
    this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.handler.onError("INTERNAL_ERROR", "正在重连，请稍后再试");
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private async getTicket(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/rooms/${this.roomCode}/socket-ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.playerToken}` },
    });
    if (!response.ok) throw new Error(`ticket ${response.status}`);
    return ((await response.json()) as { ticket: string }).ticket;
  }
}
