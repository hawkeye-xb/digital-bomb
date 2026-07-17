// ─── 公开视图脱敏 ───

import type { RoomState, PublicRoomView, PublicPlayer, PublicGame } from "../shared/domain.js";

type PresenceMap = Map<string, boolean>;

export function toPublicRoomView(
  state: RoomState,
  viewerPlayerId: string | null,
  presence: PresenceMap,
): PublicRoomView {
  const gameEnded = state.phase === "finished" || state.phase === "expired";

  const publicPlayers: PublicPlayer[] = state.players.map((p) => ({
    id: p.id,
    seat: p.seat,
    name: p.name,
    ready: p.ready,
    connected: presence.get(p.id) ?? false,
    // 游戏结束前只展示自己的 secret
    secret: gameEnded || p.id === viewerPlayerId ? p.secret : null,
  }));

  const publicGame: PublicGame | null = state.currentGame
    ? {
        gameNumber: state.currentGame.gameNumber,
        firstPlayerId: state.currentGame.firstPlayerId,
        currentPlayerId: state.currentGame.currentPlayerId,
        winnerPlayerId: state.currentGame.winnerPlayerId,
        loserPlayerId: state.currentGame.loserPlayerId,
        startedAt: state.currentGame.startedAt,
        finishedAt: state.currentGame.finishedAt,
        turns: state.currentGame.turns,
      }
    : null;

  const publicCompleted: PublicGame[] = state.completedGames.map((g) => ({
    gameNumber: g.gameNumber,
    firstPlayerId: g.firstPlayerId,
    currentPlayerId: g.currentPlayerId,
    winnerPlayerId: g.winnerPlayerId,
    loserPlayerId: g.loserPlayerId,
    startedAt: g.startedAt,
    finishedAt: g.finishedAt,
    turns: g.turns,
  }));

  return {
    roomCode: state.roomCode,
    phase: state.phase,
    version: state.version,
    players: publicPlayers,
    currentGame: publicGame,
    completedGames: publicCompleted,
    previousLoserId: state.previousLoserId,
    rematchReadyPlayerIds: state.rematchReadyPlayerIds,
    createdAt: state.createdAt,
    lastActivityAt: state.lastActivityAt,
    expiresAt: state.expiresAt,
    viewerPlayerId,
  };
}
