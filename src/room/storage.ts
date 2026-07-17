// ─── Durable Object 存储封装 ───

import type { RoomState } from "../shared/domain.js";
import type { DurableObjectStorage } from "@cloudflare/workers-types";

const STATE_KEY = "room_state";

export async function loadState(storage: DurableObjectStorage): Promise<RoomState | null> {
  const raw = await storage.get<string>(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RoomState;
  } catch {
    return null;
  }
}

export async function saveState(storage: DurableObjectStorage, state: RoomState): Promise<void> {
  await storage.put(STATE_KEY, JSON.stringify(state));
}

export async function deleteAllState(storage: DurableObjectStorage): Promise<void> {
  await storage.deleteAll();
}
