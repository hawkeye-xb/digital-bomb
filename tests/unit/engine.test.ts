// ─── engine 纯单元测试 ───

import { describe, it, expect, beforeEach } from "vitest";
import {
  countExactHits,
  initializeRoomState,
  createPlayer,
  addPlayer,
  readySet,
  readyUnset,
  submitGuess,
  rematchSet,
  isExpired,
} from "@room/engine";
import type { RoomState, PrivatePlayer } from "@shared/domain";
import { DomainError } from "@shared/validation";

// ─── 辅助 ───

function makePlayer(id: string, name: string, seat: 1 | 2): PrivatePlayer {
  return createPlayer(id, name, "hash_" + id, seat);
}

function makeRoom(): RoomState {
  const p1 = makePlayer("p1", "Alice", 1);
  return initializeRoomState("TEST01", p1, 1000);
}

function joinP2(state: RoomState): RoomState {
  const p2 = makePlayer("p2", "Bob", 2);
  return addPlayer(state, p2, 2000);
}

// ─── countExactHits ───

describe("countExactHits", () => {
  it("3333 vs 1111 → 0 hits", () => {
    expect(countExactHits("3333", "1111")).toBe(0);
  });

  it("完全匹配 → 4 hits", () => {
    expect(countExactHits("1234", "1234")).toBe(4);
  });

  it("部分匹配按位置算", () => {
    expect(countExactHits("1234", "1256")).toBe(2);
    expect(countExactHits("1234", "1564")).toBe(2);
  });

  it("重复数字分别计算", () => {
    // secret 3333, guess 3311 → 只有前两位匹配
    expect(countExactHits("3333", "3311")).toBe(2);
    // secret 1122, guess 1111 → 只有第一位和第四位匹配? No, 前两位匹配
    expect(countExactHits("1122", "1111")).toBe(2);
  });

  it("0123 合法四位", () => {
    expect(countExactHits("0123", "0123")).toBe(4);
  });

  it("非四位数抛错", () => {
    expect(() => countExactHits("123", "1234")).toThrow(DomainError);
    expect(() => countExactHits("12345", "12345")).toThrow(DomainError);
  });
});

// ─── 初始化与加入 ───

describe("房间初始化与加入", () => {
  it("创建房间后阶段为 waiting", () => {
    const room = makeRoom();
    expect(room.phase).toBe("waiting");
    expect(room.players).toHaveLength(1);
    expect(room.players[0]!.seat).toBe(1);
  });

  it("第二人加入后阶段变为 preparing", () => {
    const room = makeRoom();
    const r2 = joinP2(room);
    expect(r2.phase).toBe("preparing");
    expect(r2.players).toHaveLength(2);
  });

  it("第三人加入抛 ROOM_FULL", () => {
    const room = joinP2(makeRoom());
    const p3 = makePlayer("p3", "Charlie", 2);
    expect(() => addPlayer(room, p3, 3000)).toThrow(DomainError);
  });
});

// ─── ready 流程 ───

describe("ready 流程", () => {
  let room: RoomState;
  beforeEach(() => { room = joinP2(makeRoom()); });

  it("单人 ready 不开始游戏", () => {
    const { state } = readySet(room, "p1", "1111", "cmd1", 3000);
    expect(state.phase).toBe("preparing");
    expect(state.players.find((p) => p.id === "p1")!.ready).toBe(true);
  });

  it("双方 ready 后自动开始游戏", () => {
    const { state: s1 } = readySet(room, "p1", "1111", "cmd1", 3000);
    const { state: s2 } = readySet(s1, "p2", "2222", "cmd2", 4000);
    expect(s2.phase).toBe("playing");
    expect(s2.currentGame).not.toBeNull();
    expect(s2.currentGame!.firstPlayerId).toMatch(/^p[12]$/);
  });

  it("playing 阶段不能 ready", () => {
    const { state: s1 } = readySet(room, "p1", "1111", "cmd1", 3000);
    const { state: s2 } = readySet(s1, "p2", "2222", "cmd2", 4000);
    expect(() => readySet(s2, "p1", "3333", "cmd3", 5000)).toThrow(DomainError);
  });

  it("ready 后可以取消", () => {
    const { state: s1 } = readySet(room, "p1", "1111", "cmd1", 3000);
    const { state: s2 } = readyUnset(s1, "p1", "cmd2", 4000);
    expect(s2.players.find((p) => p.id === "p1")!.ready).toBe(false);
    expect(s2.players.find((p) => p.id === "p1")!.secret).toBeNull();
  });

  it("重复 ready 抛错", () => {
    const { state } = readySet(room, "p1", "1111", "cmd1", 3000);
    expect(() => readySet(state, "p1", "2222", "cmd2", 4000)).toThrow(DomainError);
  });
});

// ─── 猜测流程 ───

describe("猜测流程", () => {
  let playing: RoomState;
  const FIRST_ID: string = "";
  const SECOND_ID: string = "";

  beforeEach(() => {
    const room = joinP2(makeRoom());
    const { state: s1 } = readySet(room, "p1", "1234", "cmd1", 3000);
    const { state: s2 } = readySet(s1, "p2", "5678", "cmd2", 4000);
    playing = s2;
  });

  it("只有当前玩家能猜", () => {
    const cur = playing.currentGame!.currentPlayerId!;
    const other = playing.players.find((p) => p.id !== cur)!.id;
    expect(() =>
      submitGuess(playing, other, "0000", "cmd3", playing.version, 5000),
    ).toThrow(DomainError);
  });

  it("expectedVersion 过期返回 VERSION_CONFLICT", () => {
    const cur = playing.currentGame!.currentPlayerId!;
    // 用过期的 version
    expect(() =>
      submitGuess(playing, cur, "0000", "cmd3", playing.version - 1, 5000),
    ).toThrow(DomainError);
  });

  it("命中 4 位立即结束", () => {
    // p1 secret = 1234, p2 secret = 5678
    const cur = playing.currentGame!.currentPlayerId!;
    const opp = playing.players.find((p) => p.id !== cur)!;
    const oppSecret = opp.secret!;

    const { state, hitResult } = submitGuess(
      playing, cur, oppSecret, "cmd3", playing.version, 5000,
    );
    expect(hitResult!.won).toBe(true);
    expect(hitResult!.hits).toBe(4);
    expect(state.phase).toBe("finished");
    expect(state.currentGame!.winnerPlayerId).toBe(cur);
    expect(state.currentGame!.loserPlayerId).toBe(opp.id);
  });

  it("命中 0~3 切换回合", () => {
    const cur = playing.currentGame!.currentPlayerId!;
    const { state } = submitGuess(playing, cur, "0000", "cmd3", playing.version, 5000);
    expect(state.phase).toBe("playing");
    expect(state.currentGame!.currentPlayerId).not.toBe(cur);
    expect(state.currentGame!.turns).toHaveLength(1);
  });

  it("结束后不能再猜", () => {
    const cur = playing.currentGame!.currentPlayerId!;
    const opp = playing.players.find((p) => p.id !== cur)!;
    const { state } = submitGuess(
      playing, cur, opp.secret!, "cmd3", playing.version, 5000,
    );
    expect(() =>
      submitGuess(state, opp.id, "0000", "cmd4", state.version, 6000),
    ).toThrow(DomainError);
  });

  it("幂等 commandId 不产生重复 turn", () => {
    const cur = playing.currentGame!.currentPlayerId!;
    const { state: s1 } = submitGuess(playing, cur, "0000", "cmd3", playing.version, 5000);
    const { state: s2, duplicate, hitResult } = submitGuess(s1, cur, "0000", "cmd3", s1.version, 6000);
    expect(s2.currentGame!.turns).toHaveLength(1);
    expect(duplicate).toBe(true);
    expect(hitResult).toBeNull();
  });
});

// ─── 再来一局 ───

describe("再来一局", () => {
  let finished: RoomState;

  beforeEach(() => {
    const room = joinP2(makeRoom());
    const { state: s1 } = readySet(room, "p1", "1234", "cmd1", 3000);
    const { state: s2 } = readySet(s1, "p2", "5678", "cmd2", 4000);
    const cur = s2.currentGame!.currentPlayerId!;
    const opp = s2.players.find((p) => p.id !== cur)!;
    const { state: s3 } = submitGuess(s2, cur, opp.secret!, "cmd3", s2.version, 5000);
    finished = s3;
  });

  it("finished 阶段才能 rematch", () => {
    const room = joinP2(makeRoom());
    expect(() => rematchSet(room, "p1", true, "cmd", 3000)).toThrow(DomainError);
  });

  it("单人 rematch 不重置", () => {
    const { state } = rematchSet(finished, "p1", true, "cmd4", 6000);
    expect(state.phase).toBe("finished");
    expect(state.rematchReadyPlayerIds).toContain("p1");
  });

  it("双方 rematch 后进入 preparing", () => {
    const { state: s1 } = rematchSet(finished, "p1", true, "cmd4", 6000);
    const { state: s2 } = rematchSet(s1, "p2", true, "cmd5", 7000);
    expect(s2.phase).toBe("preparing");
    expect(s2.currentGame).toBeNull();
    expect(s2.completedGames).toHaveLength(1);
    // 双方 secret 清空
    expect(s2.players.every((p) => p.secret === null)).toBe(true);
    expect(s2.players.every((p) => !p.ready)).toBe(true);
  });

  it("上一局输家成为新局先手", () => {
    const loserId = finished.previousLoserId!;
    const { state: s1 } = rematchSet(finished, "p1", true, "cmd4", 6000);
    const { state: s2 } = rematchSet(s1, "p2", true, "cmd5", 7000);
    // 重新 ready 后开始游戏
    const { state: s3 } = readySet(s2, "p1", "1111", "cmd6", 8000);
    const { state: s4 } = readySet(s3, "p2", "2222", "cmd7", 9000);
    expect(s4.currentGame!.firstPlayerId).toBe(loserId);
  });

  it("可以取消 rematch", () => {
    const { state: s1 } = rematchSet(finished, "p1", true, "cmd4", 6000);
    const { state: s2 } = rematchSet(s1, "p1", false, "cmd5", 7000);
    expect(s2.rematchReadyPlayerIds).not.toContain("p1");
  });
});

// ─── 过期 ───

describe("过期", () => {
  it("waiting 阶段 2 小时后过期", () => {
    const room = makeRoom();
    const far = room.createdAt + 3 * 60 * 60 * 1000;
    expect(isExpired(room, far)).toBe(true);
    expect(isExpired(room, room.createdAt + 1 * 60 * 60 * 1000)).toBe(false);
  });
});
