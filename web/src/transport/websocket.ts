import type {
  ClientCommand,
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

type PendingCommand = ClientCommand<string, unknown>;

const COMMAND_ACK_TIMEOUT_MS = 5_000;
const BACKGROUND_RECONNECT_MS = 3_000;

export class GameTransport {
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1_000;
  private stopped = false;
  private connecting: Promise<void> | null = null;
  private lastVersion = -1;
  private awaitingSnapshot = true;
  private pendingCommands: PendingCommand[] = [];
  private inFlightCommandId: string | null = null;
  private hiddenAt: number | null = null;
  private lifecycleInstalled = false;

  constructor(
    private readonly baseUrl: string,
    private readonly roomCode: string,
    private readonly playerToken: string,
    private readonly handler: Handler,
  ) {}

  connect(): Promise<void> {
    this.stopped = false;
    this.installLifecycleRecovery();
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (!this.connecting) this.connecting = this.openSocket();
    return this.connecting;
  }

  sendCommand<T extends string, P>(type: T, payload: P, expectedVersion: number): void {
    this.pendingCommands.push({
      type,
      payload,
      expectedVersion,
      commandId: crypto.randomUUID(),
    });
    this.pumpCommands();
    if (this.socket?.readyState !== WebSocket.OPEN && !this.connecting && !this.retryTimer) {
      void this.connect();
    }
  }

  sendPresence(activity: PlayerActivity): void {
    this.sendEphemeral({ type: "presence.update", activity });
  }

  sendInteraction(interaction: InteractionKind): void {
    this.sendEphemeral({ type: "interaction.send", interaction });
  }

  disconnect(): void {
    this.stopped = true;
    this.removeLifecycleRecovery();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearAckTimer();
    this.pendingCommands = [];
    this.inFlightCommandId = null;
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
    let socket: WebSocket | null = null;
    try {
      const ticket = await this.getTicket();
      if (this.stopped) return;
      const wsBase = this.baseUrl.replace(/^http/, "ws");
      socket = new WebSocket(
        `${wsBase}/api/rooms/${this.roomCode}/socket?ticket=${encodeURIComponent(ticket)}`,
      );
      this.socket = socket;
      this.awaitingSnapshot = true;

      // Install every handler before the socket opens. The Durable Object sends
      // its first snapshot immediately and it must not race handler assignment.
      socket.onmessage = (event) => this.handleMessage(String(event.data));
      socket.onclose = () => this.handleClose(socket!);

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("连接超时"));
        }, 10_000);
        socket!.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        socket!.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new Error("连接失败"));
        };
      });

      if (this.stopped || socket !== this.socket) return;
      this.retryDelay = 1_000;
      this.handler.onConnection("connected");
      if (!this.awaitingSnapshot) this.pumpCommands();
    } catch {
      if (socket && socket === this.socket) {
        this.socket = null;
        socket.onclose = null;
        try { socket.close(); } catch { /* already closed */ }
      }
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
        this.awaitingSnapshot = false;
        if (message.version >= this.lastVersion) {
          this.lastVersion = message.version;
          this.handler.onState(message.state);
        }
        this.pumpCommands();
        break;
      case "room.updated":
        if (message.version > this.lastVersion) {
          this.lastVersion = message.version;
          this.handler.onState(message.state, message.cause);
        }
        break;
      case "command.ack":
        this.lastVersion = Math.max(this.lastVersion, message.version);
        this.pendingCommands = this.pendingCommands.filter(
          (command) => command.commandId !== message.commandId,
        );
        if (this.inFlightCommandId === message.commandId) {
          this.inFlightCommandId = null;
          this.clearAckTimer();
        }
        this.pumpCommands();
        break;
      case "presence.updated":
        this.handler.onPresence(message);
        break;
      case "interaction.received":
        this.handler.onInteraction(message.fromPlayerId, message.interaction);
        break;
      case "command.error":
        if (this.inFlightCommandId === message.commandId) {
          this.inFlightCommandId = null;
          this.clearAckTimer();
        }
        if (message.code === "VERSION_CONFLICT") {
          // Keep the idempotent command queued. Reconnect to obtain an
          // authoritative snapshot, then retry it with that current version.
          this.forceReconnect();
          return;
        }
        this.pendingCommands = this.pendingCommands.filter(
          (command) => command.commandId !== message.commandId,
        );
        this.handler.onError(message.code, message.message);
        this.pumpCommands();
        break;
      case "room.expired":
        this.handler.onExpired();
        break;
    }
  }

  private pumpCommands(): void {
    if (this.awaitingSnapshot || this.inFlightCommandId || this.socket?.readyState !== WebSocket.OPEN) return;
    const command = this.pendingCommands[0];
    if (!command) return;
    if (this.lastVersion >= 0) command.expectedVersion = this.lastVersion;
    this.inFlightCommandId = command.commandId;
    this.socket.send(JSON.stringify(command));
    this.clearAckTimer();
    this.ackTimer = setTimeout(() => this.forceReconnect(), COMMAND_ACK_TIMEOUT_MS);
  }

  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.awaitingSnapshot = true;
    this.inFlightCommandId = null;
    this.clearAckTimer();
    if (!this.stopped) this.scheduleRetry();
  }

  private forceReconnect(): void {
    if (this.stopped) return;
    const socket = this.socket;
    this.socket = null;
    this.awaitingSnapshot = true;
    this.inFlightCommandId = null;
    this.clearAckTimer();
    if (socket) {
      socket.onclose = null;
      try { socket.close(4000, "recovering connection"); } catch { /* already closed */ }
    }
    this.scheduleRetry(true);
  }

  private scheduleRetry(immediate = false): void {
    if (this.retryTimer || this.stopped) return;
    this.handler.onConnection("reconnecting");
    const delay = immediate ? 0 : this.retryDelay + Math.floor(Math.random() * 300);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    if (!immediate) this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
  }

  private sendEphemeral(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private clearAckTimer(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private installLifecycleRecovery(): void {
    if (this.lifecycleInstalled || typeof window === "undefined" || typeof document === "undefined") return;
    window.addEventListener("online", this.handleOnline);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.lifecycleInstalled = true;
  }

  private removeLifecycleRecovery(): void {
    if (!this.lifecycleInstalled || typeof window === "undefined" || typeof document === "undefined") return;
    window.removeEventListener("online", this.handleOnline);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.lifecycleInstalled = false;
  }

  private readonly handleOnline = () => {
    if (this.socket?.readyState === WebSocket.OPEN) this.forceReconnect();
    else if (!this.connecting && !this.retryTimer) void this.connect();
  };

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      this.hiddenAt = Date.now();
      return;
    }
    const backgroundFor = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = null;
    if (backgroundFor >= BACKGROUND_RECONNECT_MS && this.socket?.readyState === WebSocket.OPEN) {
      this.forceReconnect();
    } else if (this.socket?.readyState !== WebSocket.OPEN && !this.connecting && !this.retryTimer) {
      void this.connect();
    }
  };

  private async getTicket(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${this.baseUrl}/api/rooms/${this.roomCode}/socket-ticket`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.playerToken}` },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ticket ${response.status}`);
      return ((await response.json()) as { ticket: string }).ticket;
    } finally {
      clearTimeout(timeout);
    }
  }
}
