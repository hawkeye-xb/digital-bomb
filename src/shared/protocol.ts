// ─── WebSocket 消息协议 ───

import type {
  PublicRoomView,
  PublicCause,
  PlayerActivity,
  InteractionKind,
} from "./domain.js";

export type DomainErrorCode =
  | "INVALID_INPUT"
  | "INVALID_NAME"
  | "INVALID_SECRET"
  | "INVALID_GUESS"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "UNAUTHORIZED"
  | "TICKET_INVALID"
  | "WRONG_PHASE"
  | "NOT_YOUR_TURN"
  | "VERSION_CONFLICT"
  | "ALREADY_READY"
  | "COMMAND_REJECTED"
  | "INTERNAL_ERROR";

// ─── 客户端命令 ───

export type ClientCommand<TType extends string, TPayload> = {
  type: TType;
  commandId: string;
  expectedVersion: number;
  payload: TPayload;
};

export type ReadySet = ClientCommand<"ready.set", { secret: string }>;
export type ReadyUnset = ClientCommand<"ready.unset", Record<string, never>>;
export type GuessSubmit = ClientCommand<"guess.submit", { guess: string }>;
export type RematchSet = ClientCommand<"rematch.set", { ready: boolean }>;
export type StateRequest = ClientCommand<"state.request", Record<string, never>>;

export type PresenceUpdate = {
  type: "presence.update";
  activity: PlayerActivity;
};

export type InteractionSend = {
  type: "interaction.send";
  interaction: InteractionKind;
};

export type ClientMessage =
  | ReadySet
  | ReadyUnset
  | GuessSubmit
  | RematchSet
  | StateRequest
  | PresenceUpdate
  | InteractionSend;

// ─── 服务端消息 ───

export type RoomSnapshot = {
  type: "room.snapshot";
  version: number;
  state: PublicRoomView;
};

export type RoomUpdated = {
  type: "room.updated";
  version: number;
  cause: PublicCause;
  state: PublicRoomView;
};

export type RoomExpired = {
  type: "room.expired";
};

export type CommandError = {
  type: "command.error";
  commandId: string;
  code: DomainErrorCode;
  message: string;
  currentVersion: number;
};

export type PresenceUpdated = {
  type: "presence.updated";
  playerId: string;
  connected: boolean;
  activity: PlayerActivity;
};

export type InteractionReceived = {
  type: "interaction.received";
  fromPlayerId: string;
  interaction: InteractionKind;
  createdAt: number;
};

export type ServerMessage =
  | RoomSnapshot
  | RoomUpdated
  | RoomExpired
  | CommandError
  | PresenceUpdated
  | InteractionReceived;
