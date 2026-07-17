// ─── 领域类型：房间、玩家、游戏、回合 ───

export type RoomPhase = "waiting" | "preparing" | "playing" | "finished" | "expired";

export type PrivatePlayer = {
  id: string;
  seat: 1 | 2;
  name: string;
  tokenHash: string;
  secret: string | null;
  ready: boolean;
};

export type Turn = {
  turnNumber: number;
  playerId: string;
  guess: string;
  hits: 0 | 1 | 2 | 3 | 4;
  createdAt: number;
};

export type Game = {
  gameNumber: number;
  firstPlayerId: string;
  currentPlayerId: string | null;
  winnerPlayerId: string | null;
  loserPlayerId: string | null;
  startedAt: number;
  finishedAt: number | null;
  turns: Turn[];
};

export type ProcessedCommand = {
  commandId: string;
  playerId: string;
  resultingVersion: number;
};

export type RoomState = {
  schemaVersion: 1;
  roomCode: string;
  phase: RoomPhase;
  version: number;
  players: PrivatePlayer[];
  currentGame: Game | null;
  completedGames: Game[];
  previousLoserId: string | null;
  rematchReadyPlayerIds: string[];
  processedCommands: ProcessedCommand[];
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
};

// ─── 公开视图（已脱敏） ───

export type PublicPlayer = {
  id: string;
  seat: 1 | 2;
  name: string;
  ready: boolean;
  connected: boolean;
  secret: string | null; // 游戏结束前只展示自己的 secret
};

export type PublicGame = {
  gameNumber: number;
  firstPlayerId: string;
  currentPlayerId: string | null;
  winnerPlayerId: string | null;
  loserPlayerId: string | null;
  startedAt: number;
  finishedAt: number | null;
  turns: Turn[];
};

export type PublicRoomView = {
  roomCode: string;
  phase: RoomPhase;
  version: number;
  players: PublicPlayer[];
  currentGame: PublicGame | null;
  completedGames: PublicGame[];
  previousLoserId: string | null;
  rematchReadyPlayerIds: string[];
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  viewerPlayerId: string | null;
};

// ─── 公开 cause（驱动 UI 动画） ───

export type PublicCause =
  | { type: "player.joined"; playerId: string }
  | { type: "ready.changed"; playerId: string; ready: boolean }
  | { type: "game.started"; firstPlayerId: string }
  | {
      type: "guess.resolved";
      playerId: string;
      guess: string;
      hits: 0 | 1 | 2 | 3 | 4;
      won: boolean;
    }
  | { type: "rematch.changed"; playerId: string; ready: boolean }
  | { type: "game.reset"; firstPlayerId: string };
