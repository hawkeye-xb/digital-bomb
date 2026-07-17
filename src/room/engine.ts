// ─── 纯游戏状态机（无 Cloudflare 依赖） ───

import type {
  RoomState,
  Game,
  Turn,
  PrivatePlayer,
  RoomPhase,
} from "../shared/domain.js";
import { DomainError } from "../shared/validation.js";

// ─── 命中计算 ───

export function countExactHits(secret: string, guess: string): 0 | 1 | 2 | 3 | 4 {
  if (secret.length !== 4 || guess.length !== 4) {
    throw new DomainError("INVALID_INPUT", "密码和猜测必须为四位数字");
  }
  let hits = 0;
  for (let i = 0; i < 4; i++) {
    if (secret[i] === guess[i]) hits++;
  }
  return hits as 0 | 1 | 2 | 3 | 4;
}

// ─── 房间码字符集（不含 0/O/1/I） ───

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[arr[i]! % CODE_CHARS.length]!;
  }
  return code;
}

// ─── 创建玩家 ───

export function createPlayer(id: string, name: string, tokenHash: string, seat: 1 | 2): PrivatePlayer {
  return {
    id,
    seat,
    name,
    tokenHash,
    secret: null,
    ready: false,
  };
}

// ─── 初始化房间 ───

export function initializeRoomState(
  roomCode: string,
  creator: PrivatePlayer,
  now: number,
): RoomState {
  return {
    schemaVersion: 1,
    roomCode,
    phase: "waiting",
    version: 0,
    players: [creator],
    currentGame: null,
    completedGames: [],
    previousLoserId: null,
    rematchReadyPlayerIds: [],
    processedCommands: [],
    totalGamesPlayed: 0,
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 2 * 60 * 60 * 1000, // 2 小时
  };
}

// ─── 添加玩家 ───

export function addPlayer(state: RoomState, player: PrivatePlayer, now: number): RoomState {
  if (state.players.length >= 2) {
    throw new DomainError("ROOM_FULL", "房间已有两名玩家");
  }
  if (state.players.some((p) => p.id === player.id)) return state;

  const newState = { ...state, players: [...state.players, player] };
  newState.phase = "preparing";
  newState.version += 1;
  newState.lastActivityAt = now;
  newState.expiresAt = now + 24 * 60 * 60 * 1000; // 24h
  return newState;
}

// ─── 处理幂等 ───

function isAlreadyProcessed(state: RoomState, commandId: string, playerId: string): boolean {
  return state.processedCommands.some(
    (c) => c.commandId === commandId && c.playerId === playerId,
  );
}

function markProcessed(state: RoomState, commandId: string, playerId: string): RoomState {
  const cmds = [
    ...state.processedCommands,
    { commandId, playerId, resultingVersion: state.version },
  ];
  // 每名玩家最多保留 32 条
  const byPlayer = new Map<string, typeof cmds>();
  for (const c of cmds) {
    const list = byPlayer.get(c.playerId) || [];
    list.push(c);
    byPlayer.set(c.playerId, list);
  }
  return {
    ...state,
    processedCommands: cmds.slice(-64), // 容错剪裁
  };
}

// ─── ready.set ───

export function readySet(
  state: RoomState,
  playerId: string,
  secret: string,
  commandId: string,
  now: number,
): { state: RoomState } {
  if (isAlreadyProcessed(state, commandId, playerId)) return { state };

  if (state.phase !== "preparing") {
    throw new DomainError("WRONG_PHASE", "当前阶段不允许准备");
  }

  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new DomainError("UNAUTHORIZED", "玩家不存在");
  if (player.ready) throw new DomainError("ALREADY_READY", "你已经准备好了");

  const newPlayers = state.players.map((p) =>
    p.id === playerId ? { ...p, ready: true, secret } : p,
  );

  let newState: RoomState = {
    ...state,
    players: newPlayers,
    version: state.version + 1,
    lastActivityAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
  };
  newState = markProcessed(newState, commandId, playerId);

  // 双方都 ready 则开始游戏
  if (newState.players.length === 2 && newState.players.every((p) => p.ready)) {
    newState = startGame(newState, now);
  }

  return { state: newState };
}

// ─── ready.unset ───

export function readyUnset(
  state: RoomState,
  playerId: string,
  commandId: string,
  now: number,
): { state: RoomState } {
  if (isAlreadyProcessed(state, commandId, playerId)) return { state };

  if (state.phase !== "preparing") {
    throw new DomainError("WRONG_PHASE", "当前阶段不允许取消准备");
  }

  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new DomainError("UNAUTHORIZED", "玩家不存在");

  const newPlayers = state.players.map((p) =>
    p.id === playerId ? { ...p, ready: false, secret: null } : p,
  );

  let newState: RoomState = {
    ...state,
    players: newPlayers,
    version: state.version + 1,
    lastActivityAt: now,
  };
  newState = markProcessed(newState, commandId, playerId);
  return { state: newState };
}

// ─── 开始游戏 ───

function startGame(state: RoomState, now: number): RoomState {
  const players = state.players;
  if (players.length !== 2) throw new DomainError("COMMAND_REJECTED", "需要两名玩家");

  // 先手：第一局随机；后续输家先手
  const firstPlayerId =
    state.previousLoserId && players.some((p) => p.id === state.previousLoserId)
      ? state.previousLoserId
      : players[Math.random() < 0.5 ? 0 : 1]!.id;

  const gameNumber = state.totalGamesPlayed + 1;
  const nextTotal = state.totalGamesPlayed + 1;

  const game: Game = {
    gameNumber,
    firstPlayerId,
    currentPlayerId: firstPlayerId,
    winnerPlayerId: null,
    loserPlayerId: null,
    startedAt: now,
    finishedAt: null,
    turns: [],
  };

  return {
    ...state,
    phase: "playing",
    version: state.version + 1,
    totalGamesPlayed: nextTotal,
    currentGame: game,
  };
}

// ─── 提交猜测 ───

export function submitGuess(
  state: RoomState,
  playerId: string,
  guess: string,
  commandId: string,
  expectedVersion: number,
  now: number,
): { state: RoomState; hitResult: { hits: 0 | 1 | 2 | 3 | 4; won: boolean } } {
  if (isAlreadyProcessed(state, commandId, playerId)) return { state, hitResult: { hits: 0, won: false } };

  if (state.phase !== "playing") {
    throw new DomainError("WRONG_PHASE", "游戏未在进行中");
  }

  if (expectedVersion !== state.version) {
    throw new DomainError("VERSION_CONFLICT", "状态已更新，请刷新");
  }

  const game = state.currentGame;
  if (!game) throw new DomainError("INTERNAL_ERROR", "无进行中的游戏");

  if (game.currentPlayerId !== playerId) {
    throw new DomainError("NOT_YOUR_TURN", "还没轮到你");
  }

  const opponent = state.players.find((p) => p.id !== playerId);
  if (!opponent || !opponent.secret) {
    throw new DomainError("INTERNAL_ERROR", "对手未设置密码");
  }

  const hits = countExactHits(opponent.secret, guess);
  const won = hits === 4;

  const turn: Turn = {
    turnNumber: game.turns.length + 1,
    playerId,
    guess,
    hits,
    createdAt: now,
  };

  const updatedGame: Game = {
    ...game,
    turns: [...game.turns, turn],
    currentPlayerId: won ? null : opponent.id,
    winnerPlayerId: won ? playerId : null,
    loserPlayerId: won ? opponent.id : null,
    finishedAt: won ? now : null,
  };

  let newState: RoomState = {
    ...state,
    currentGame: updatedGame,
    version: state.version + 1,
    lastActivityAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
  };

  if (won) {
    newState.phase = "finished";
    newState.previousLoserId = opponent.id;
    newState.expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 天
  }

  newState = markProcessed(newState, commandId, playerId);
  return { state: newState, hitResult: { hits, won } };
}

// ─── 再来一局 ───

export function rematchSet(
  state: RoomState,
  playerId: string,
  ready: boolean,
  commandId: string,
  now: number,
): { state: RoomState } {
  if (isAlreadyProcessed(state, commandId, playerId)) return { state };

  if (state.phase !== "finished") {
    throw new DomainError("WRONG_PHASE", "游戏已结束，等待再来一局");
  }

  let rematchReady: string[] = [...state.rematchReadyPlayerIds];

  if (ready && !rematchReady.includes(playerId)) {
    rematchReady = [...rematchReady, playerId];
  } else if (!ready) {
    rematchReady = rematchReady.filter((id) => id !== playerId);
  }

  let newState: RoomState = {
    ...state,
    rematchReadyPlayerIds: rematchReady,
    version: state.version + 1,
    lastActivityAt: now,
  };
  newState = markProcessed(newState, commandId, playerId);

  // 双方同意 → 重置准备状态，存入 completedGames，进入 preparing
  if (rematchReady.length >= 2) {
    newState = resetForNewGame(newState, now);
  }

  return { state: newState };
}

function resetForNewGame(state: RoomState, now: number): RoomState {
  const completedGames = state.currentGame
    ? [...state.completedGames, state.currentGame].slice(-20)
    : state.completedGames;

  const resetPlayers = state.players.map((p) => ({
    ...p,
    secret: null,
    ready: false,
  }));

  return {
    ...state,
    phase: "preparing",
    version: state.version + 1,
    players: resetPlayers,
    currentGame: null,
    completedGames,
    rematchReadyPlayerIds: [],
    lastActivityAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
  };
}

// ─── 计算过期时间 ───

export function computeExpiresAt(phase: RoomPhase, now: number): number {
  switch (phase) {
    case "waiting":
      return now + 2 * 60 * 60 * 1000;
    case "preparing":
    case "playing":
      return now + 24 * 60 * 60 * 1000;
    case "finished":
      return now + 7 * 24 * 60 * 60 * 1000;
    case "expired":
      return 0;
  }
}

// ─── 检查是否过期 ───

export function isExpired(state: RoomState, now: number): boolean {
  return now > state.expiresAt;
}
