import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameTransport } from "../../web/src/transport/websocket.js";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function roomState(version: number) {
  return {
    roomCode: "ABC234",
    phase: "playing",
    version,
    players: [],
    currentGame: null,
    completedGames: [],
    previousLoserId: null,
    rematchReadyPlayerIds: [],
    createdAt: 1,
    lastActivityAt: 1,
    expiresAt: 2,
    viewerPlayerId: "p1",
  };
}

async function nextSocket(index = 0) {
  for (let i = 0; i < 10 && FakeWebSocket.instances.length <= index; i++) {
    await Promise.resolve();
  }
  return FakeWebSocket.instances[index]!;
}

describe("GameTransport recovery", () => {
  const onState = vi.fn();
  const onConnection = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    onState.mockReset();
    onConnection.mockReset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ ticket: "ticket" }),
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createTransport() {
    return new GameTransport("https://game.test", "ABC234", "token", {
      onState,
      onPresence: vi.fn(),
      onInteraction: vi.fn(),
      onConnection,
      onError: vi.fn(),
      onExpired: vi.fn(),
    });
  }

  it("installs the message listener before the socket opens", async () => {
    const transport = createTransport();
    const connecting = transport.connect();
    const socket = await nextSocket();

    socket.message({ type: "room.snapshot", version: 1, state: roomState(1) });
    socket.open();
    await connecting;

    expect(onState).toHaveBeenCalledWith(roomState(1));
    expect(onConnection).toHaveBeenLastCalledWith("connected");
    transport.disconnect();
  });

  it("reconnects and replays an unacknowledged command with the latest version", async () => {
    const transport = createTransport();
    const connecting = transport.connect();
    const first = await nextSocket();
    first.open();
    first.message({ type: "room.snapshot", version: 4, state: roomState(4) });
    await connecting;

    transport.sendCommand("guess.submit", { guess: "1234" }, 4);
    const original = JSON.parse(first.sent.at(-1)!);
    expect(original.expectedVersion).toBe(4);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1);
    const second = await nextSocket(1);
    expect(second).not.toBe(first);
    second.open();
    second.message({ type: "room.snapshot", version: 5, state: roomState(5) });

    const replay = JSON.parse(second.sent.at(-1)!);
    expect(replay.commandId).toBe(original.commandId);
    expect(replay.expectedVersion).toBe(5);
    expect(onConnection).toHaveBeenCalledWith("reconnecting");

    second.message({ type: "command.ack", commandId: replay.commandId, version: 6 });
    transport.disconnect();
  });
});
