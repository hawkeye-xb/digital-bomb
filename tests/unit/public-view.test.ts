// ─── public-view 脱敏测试 ───

import { describe, it, expect } from "vitest";
import { toPublicRoomView } from "@room/public-view";
import { initializeRoomState, createPlayer, addPlayer, readySet } from "@room/engine";
import type { RoomState } from "@shared/domain";

function makeTwoPlayerRoom(): { room: RoomState; p1Id: string; p2Id: string } {
  const p1 = createPlayer("p1", "Alice", "h1", 1);
  const p2 = createPlayer("p2", "Bob", "h2", 2);
  let room = initializeRoomState("TST01", p1, 1000);
  room = addPlayer(room, p2, 2000);
  return { room, p1Id: "p1", p2Id: "p2" };
}

describe("toPublicRoomView", () => {
  const online = { connected: true, activity: "idle" as const };
  it("游戏结束前绝不泄露对方 secret", () => {
    let { room } = makeTwoPlayerRoom();
    const { state: s1 } = readySet(room, "p1", "1111", "c1", 3000);
    const { state: s2 } = readySet(s1, "p2", "2222", "c2", 3000);

    const viewP1 = toPublicRoomView(s2, "p1", new Map([["p1", online], ["p2", online]]));
    expect(viewP1.players.find((p: { id: string; secret: string | null }) => p.id === "p1")!.secret).toBe("1111");
    expect(viewP1.players.find((p: { id: string; secret: string | null }) => p.id === "p2")!.secret).toBeNull();

    const viewP2 = toPublicRoomView(s2, "p2", new Map([["p1", online], ["p2", online]]));
    expect(viewP2.players.find((p: { id: string; secret: string | null }) => p.id === "p1")!.secret).toBeNull();
    expect(viewP2.players.find((p: { id: string; secret: string | null }) => p.id === "p2")!.secret).toBe("2222");
  });

  it("游戏结束后双方都能看到秘密", () => {
    // Create a finished game state
    let { room } = makeTwoPlayerRoom();
    const { state: s1 } = readySet(room, "p1", "1111", "c1", 3000);
    const { state: s2 } = readySet(s1, "p2", "2222", "c2", 3000);

    // Manually mark as finished
    const finished = {
      ...s2,
      phase: "finished" as const,
      currentGame: {
        ...s2.currentGame!,
        winnerPlayerId: "p1",
        loserPlayerId: "p2",
        finishedAt: 4000,
      },
    };

    const viewP2 = toPublicRoomView(finished, "p2", new Map());
    expect(viewP2.players.find((p: { id: string }) => p.id === "p1")!.secret).toBe("1111");
    expect(viewP2.players.find((p: { id: string }) => p.id === "p2")!.secret).toBe("2222");
  });

  it("不发送 tokenHash 和 processedCommands", () => {
    const { room } = makeTwoPlayerRoom();
    const view = toPublicRoomView(room, "p1", new Map());
    const v = view as Record<string, unknown>;
    expect(v.tokenHash).toBeUndefined();
    expect(v.processedCommands).toBeUndefined();
  });

  it("presence 正确反映连接状态", () => {
    const { room } = makeTwoPlayerRoom();
    const view = toPublicRoomView(room, "p1", new Map([["p1", { connected: true, activity: "typing" as const }]]));
    expect(view.players.find((p: { id: string }) => p.id === "p1")!.connected).toBe(true);
    expect(view.players.find((p: { id: string }) => p.id === "p1")!.activity).toBe("typing");
    expect(view.players.find((p: { id: string }) => p.id === "p2")!.connected).toBe(false);
  });
});
