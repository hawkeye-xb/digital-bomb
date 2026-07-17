// @vitest-environment jsdom

import React, { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const connect = vi.fn(async () => {});

vi.mock("../../web/src/transport/websocket.js", () => ({
  GameTransport: class {
    connect = connect;
    disconnect() {}
    sendCommand() {}
    sendPresence() {}
    sendInteraction() {}
  },
}));

import App from "../../web/src/app/App.js";

function joinedRoom() {
  return {
    roomCode: "ABC234",
    phase: "preparing" as const,
    version: 1,
    players: [
      { id: "p1", seat: 1 as const, name: "Alice", ready: false, connected: true, activity: "idle" as const, secret: null },
      { id: "p2", seat: 2 as const, name: "Bob", ready: false, connected: false, activity: "idle" as const, secret: null },
    ],
    currentGame: null,
    completedGames: [],
    previousLoserId: null,
    rematchReadyPlayerIds: [],
    createdAt: 1,
    lastActivityAt: 1,
    expiresAt: Date.now() + 60_000,
    viewerPlayerId: "p2",
  };
}

function createdRoom() {
  const room = joinedRoom();
  return {
    ...room,
    phase: "waiting" as const,
    players: [room.players[0]],
    viewerPlayerId: "p1",
  };
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
  connect.mockClear();
  vi.restoreAllMocks();
});

afterEach(cleanup);

describe("invite flow", () => {
  it("does not consume a seat before a first-time guest enters a name", async () => {
    history.replaceState(null, "", "/r/ABC234");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        playerId: "p2",
        playerToken: "guest-token",
        roomState: joinedRoom(),
      }),
    } as Response);

    const user = userEvent.setup();
    render(<StrictMode><App /></StrictMode>);

    const joinButton = screen.getByRole("button", { name: "加入房间 ABC234" }) as HTMLButtonElement;
    expect(joinButton.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("你的昵称"), "Bob");
    expect(joinButton.disabled).toBe(false);
    await user.click(joinButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0]!;
    expect(request[0]).toBe("/api/rooms/ABC234/join");
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({ name: "Bob", tokenHash: "" });

    // The /join response is rendered immediately; a delayed socket snapshot
    // can no longer leave the guest on a misleading "创建中" screen.
    expect(await screen.findByRole("button", { name: "离开" })).toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("requires a name before creating a room", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<App />);
    const createButton = screen.getByRole("button", { name: "创建房间" }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders a newly created room before the socket snapshot arrives", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        roomCode: "ABC234",
        playerId: "p1",
        playerToken: "creator-token",
        roomState: createdRoom(),
      }),
    } as Response);
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText("你的昵称"), "Alice");
    await user.click(screen.getByRole("button", { name: "创建房间" }));

    expect(await screen.findByRole("button", { name: "离开" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reuses a saved seat from an invite link instead of joining again", async () => {
    history.replaceState(null, "", "/r/ABC234");
    localStorage.setItem("digital-bomb-players", JSON.stringify({
      ABC234: { token: "guest-token", name: "Bob" },
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        playerId: "p2",
        playerToken: "",
        roomState: joinedRoom(),
      }),
    } as Response);

    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByRole("button", { name: "离开" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.name).toBe("Bob");
    expect(body.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
