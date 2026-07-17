// 轻量埋点包装 — 静默失败，不阻塞游戏逻辑
// 隐私红线：不采集昵称、猜的数字、房间码等任何内容数据

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function track(name: string, props?: Record<string, unknown>): void {
  if (!isBrowser()) return;
  const ph = (window as any).posthog;
  if (!ph?.capture) return;
  try {
    ph.capture(name, props ?? {});
  } catch {
    /* 埋点失败不阻塞游戏 */
  }
}

// WebSocket 连接耗时（从开始连接到 onopen）
export function trackWsConnect(durationMs: number, isReconnect: boolean): void {
  track("digital_bomb_ws_connect", {
    duration_ms: durationMs,
    reconnect: isReconnect,
  });
}

// 命令往返耗时（从 send 到 ack）
export function trackCommandLatency(commandType: string, durationMs: number): void {
  track("digital_bomb_command_latency", {
    command: commandType,
    duration_ms: durationMs,
  });
}

// 房间操作耗时
export function trackRoomOp(op: "create" | "join", durationMs: number, success: boolean): void {
  track(`digital_bomb_room_${op}`, {
    duration_ms: durationMs,
    success,
  });
}

// 猜数字耗时（不记录猜的内容）
export function trackGuess(durationMs: number): void {
  track("digital_bomb_guess", {
    duration_ms: durationMs,
  });
}

// 重连事件
export function trackReconnect(attempt: number): void {
  track("digital_bomb_ws_reconnect", { attempt });
}
