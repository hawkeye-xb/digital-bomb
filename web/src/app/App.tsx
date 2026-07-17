// ─── 主应用 ───

import React, { useState, useCallback, useEffect, useRef } from "react";
import type {
  InteractionKind,
  PlayerActivity,
  PublicCause,
  PublicRoomView,
  PublicPlayer,
  PublicGame,
} from "../../../src/shared/domain.js";
import { GameTransport, type ConnectionState } from "../transport/websocket.js";

const API = "/api";

type AppPhase = "home" | "invite" | "creating" | "joining" | "in-room";

type AppState = {
  phase: AppPhase;
  roomCode: string;
  playerToken: string;
  playerId: string;
  name: string;
  roomState: PublicRoomView | null;
  error: string | null;
  connection: ConnectionState;
  notice: string | null;
};


// ─── 从 localStorage 恢复 ───

function loadStorage(): Record<string, { token: string; name: string }> {
  try {
    return JSON.parse(localStorage.getItem("digital-bomb-players") || "{}");
  } catch {
    return {};
  }
}

function saveStorage(roomCode: string, token: string, name: string) {
  const data = loadStorage();
  data[roomCode] = { token, name };
  localStorage.setItem("digital-bomb-players", JSON.stringify(data));
}

function inviteCodeFromPath(): string {
  return location.pathname.match(/^\/r\/([A-HJ-NP-Z2-9]{6})$/i)?.[1]?.toUpperCase() || "";
}

function isValidClientName(name: string): boolean {
  return /^\S{1,16}$/.test(name);
}

export default function App() {
  const [state, setState] = useState<AppState>(() => {
    const inviteCode = inviteCodeFromPath();
    const storage = loadStorage();
    return {
      phase: inviteCode ? "invite" : "home",
      roomCode: inviteCode,
      playerToken: "",
      playerId: "",
      name: storage[inviteCode]?.name || storage["_lastName"]?.name || "",
      roomState: null,
      error: null,
      connection: "connecting",
      notice: null,
    };
  });

  const transportRef = useRef<GameTransport | null>(null);
  const createInFlightRef = useRef(false);
  const joinInFlightRef = useRef(false);

  // ─── 处理服务端消息 ───



  // ─── 创建房间 ───

  const createRoom = useCallback(async () => {
    const name = state.name.trim();
    if (!isValidClientName(name)) {
      setState((s) => ({ ...s, error: "请先输入 1～16 个字符的昵称" }));
      return;
    }
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    setState((s) => ({ ...s, phase: "creating", error: null }));
    try {
      const resp = await fetch(`${API}/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await resp.json()) as {
        roomCode: string;
        playerToken: string;
        playerId: string;
        roomState: PublicRoomView;
        roomUrl?: string;
        error?: { code: string; message: string };
      };

      if (data.error) {
        setState((s) => ({ ...s, error: data.error!.message, phase: "home" }));
        return;
      }

      saveStorage(data.roomCode, data.playerToken, name);
      saveStorage("_lastName", "", name);
      history.replaceState(null, "", `/r/${data.roomCode}`);

      const t = new GameTransport(location.origin, data.roomCode, data.playerToken, {
        onState: (s, cause) => setState((prev) => ({
          ...prev,
          roomState: s,
          phase: "in-room",
          notice: noticeForCause(s, cause) ?? prev.notice,
        })),
        onPresence: (message) => setState((prev) => ({
          ...prev,
          roomState: prev.roomState ? {
            ...prev.roomState,
            players: prev.roomState.players.map((p) => p.id === message.playerId
              ? { ...p, connected: message.connected, activity: message.activity }
              : p),
          } : null,
        })),
        onInteraction: (from, interaction) => setState((prev) => ({
          ...prev,
          notice: interactionText(prev.roomState?.players.find((p) => p.id === from)?.name, interaction),
        })),
        onConnection: (connection) => setState((prev) => ({ ...prev, connection })),
        onError: (code, msg) => setState((prev) => ({ ...prev, error: msg })),
        onExpired: () => setState((prev) => ({ ...prev, error: "房间已过期", phase: "home", roomState: null })),
      });

      transportRef.current = t;

      setState((s) => ({
        ...s,
        phase: "in-room",
        roomCode: data.roomCode,
        playerToken: data.playerToken,
        playerId: data.playerId,
        name,
        roomState: data.roomState,
        connection: "connecting",
      }));

      await t.connect();
    } catch (err) {
      setState((s) => ({
        ...s,
        error: "创建房间失败，请重试",
        phase: "home",
      }));
    } finally {
      createInFlightRef.current = false;
    }
  }, [state.name]);

  // ─── 加入房间 ───

  const joinRoom = useCallback(async (code: string, name: string) => {
    const normalizedName = name.trim();
    if (!isValidClientName(normalizedName)) {
      setState((s) => ({ ...s, error: "请先输入 1～16 个字符的昵称" }));
      return;
    }
    if (joinInFlightRef.current) return;
    joinInFlightRef.current = true;
    setState((s) => ({ ...s, phase: "joining", error: null }));

    const storage = loadStorage();
    const saved = storage[code];

    try {
      const resp = await fetch(`${API}/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: normalizedName,
          tokenHash: saved ? await hashToken(saved.token) : "",
        }),
      });
      const data = (await resp.json()) as {
        playerId: string;
        playerToken: string;
        roomState: PublicRoomView;
        error?: { code: string; message: string };
      };

      if (data.error) {
        setState((s) => ({
          ...s,
          error: data.error!.message,
          phase: inviteCodeFromPath() === code ? "invite" : "home",
        }));
        return;
      }

      const finalToken = saved?.token || data.playerToken;
      saveStorage(code, finalToken, normalizedName);
      saveStorage("_lastName", "", normalizedName);
      history.replaceState(null, "", `/r/${code}`);

      const t = new GameTransport(location.origin, code, finalToken, {
        onState: (s, cause) => setState((prev) => ({
          ...prev,
          roomState: s,
          phase: "in-room",
          notice: noticeForCause(s, cause) ?? prev.notice,
        })),
        onPresence: (message) => setState((prev) => ({
          ...prev,
          roomState: prev.roomState ? {
            ...prev.roomState,
            players: prev.roomState.players.map((p) => p.id === message.playerId
              ? { ...p, connected: message.connected, activity: message.activity }
              : p),
          } : null,
        })),
        onInteraction: (from, interaction) => setState((prev) => ({
          ...prev,
          notice: interactionText(prev.roomState?.players.find((p) => p.id === from)?.name, interaction),
        })),
        onConnection: (connection) => setState((prev) => ({ ...prev, connection })),
        onError: (code, msg) => setState((prev) => ({ ...prev, error: msg })),
        onExpired: () => setState((prev) => ({ ...prev, error: "房间已过期", phase: "home", roomState: null })),
      });

      transportRef.current = t;

      setState((s) => ({
        ...s,
        phase: "in-room",
        roomCode: code,
        playerToken: finalToken,
        playerId: data.playerId,
        name: normalizedName,
        roomState: data.roomState,
        connection: "connecting",
      }));

      await t.connect();
    } catch {
      setState((s) => ({
        ...s,
        error: "加入失败，请检查房间码或网络",
        phase: inviteCodeFromPath() === code ? "invite" : "home",
      }));
    } finally {
      joinInFlightRef.current = false;
    }
  }, []);

  // ─── 发送命令 ───

  const sendCommand = useCallback(
    <T extends string, P>(type: T, payload: P) => {
      if (!state.roomState) return;
      transportRef.current?.sendCommand(type, payload, state.roomState.version);
    },
    [state.roomState],
  );

  const sendPresence = useCallback((activity: PlayerActivity) => {
    transportRef.current?.sendPresence(activity);
  }, []);

  const sendInteraction = useCallback((interaction: InteractionKind) => {
    transportRef.current?.sendInteraction(interaction);
  }, []);

  // ─── 返回首页 ───

  const goHome = useCallback(() => {
    transportRef.current?.disconnect();
    transportRef.current = null;
    history.replaceState(null, "", "/");
    setState((s) => ({
      ...s,
      phase: "home",
      roomCode: "",
      roomState: null,
      error: null,
    }));
  }, []);

  const cancelInvite = useCallback(() => {
    history.replaceState(null, "", "/");
    setState((s) => ({ ...s, phase: "home", roomCode: "", error: null }));
  }, []);

  // ─── 从 URL 检测房间码 ───

  useEffect(() => {
    if (state.phase !== "invite" || !state.roomCode) return;
    const saved = loadStorage()[state.roomCode];
    if (saved?.token && isValidClientName(saved.name)) {
      void joinRoom(state.roomCode, saved.name);
    }
  }, [state.phase, state.roomCode, joinRoom]);

  // ─── 前台恢复 ───

  // ─── 渲染 ───

  if (state.phase === "in-room" && state.roomState) {
    return (
      <RoomScreen
        roomState={state.roomState}
        playerId={state.playerId}
        playerName={state.name}
        sendCommand={sendCommand}
        sendPresence={sendPresence}
        sendInteraction={sendInteraction}
        goHome={goHome}
        connection={state.connection}
        error={state.error}
        onClearError={() => setState((s) => ({ ...s, error: null }))}
        notice={state.notice}
        onClearNotice={() => setState((s) => ({ ...s, notice: null }))}
      />
    );
  }

  return (
    <HomeScreen
      name={state.name}
      setName={(n) => setState((s) => ({ ...s, name: n }))}
      onCreate={createRoom}
      onJoin={(code) => joinRoom(code, state.name)}
      inviteCode={inviteCodeFromPath()}
      onCancelInvite={cancelInvite}
      loadingPhase={state.phase === "creating" || state.phase === "joining" ? state.phase : null}
      error={state.error}
      onClearError={() => setState((s) => ({ ...s, error: null }))}
    />
  );
}

// ─── 简单 hash helper ───

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function interactionText(name: string | undefined, interaction: InteractionKind): string {
  const who = name || "对方";
  switch (interaction) {
    case "nudge": return `${who} 轻轻催了你一下 👀`;
    case "almost": return `${who}：我真的就差一点！😤`;
    case "nice": return `${who}：这把猜得漂亮 👏`;
    case "rematch": return `${who}：不服，再来一局！🔥`;
  }
}

function noticeForCause(state: PublicRoomView, cause?: PublicCause): string | null {
  if (cause?.type !== "guess.resolved" || cause.playerId === state.viewerPlayerId) return null;
  const name = state.players.find((player) => player.id === cause.playerId)?.name || "对方";
  const message = `${name} 猜了 ${cause.guess}：${hitsText(cause.hits)}`;
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(80);
  if (typeof document !== "undefined" && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification("数字炸弹", { body: message });
  }
  return message;
}

// ─── 首页 ───

function HomeScreen({
  name,
  setName,
  onCreate,
  onJoin,
  inviteCode,
  onCancelInvite,
  loadingPhase,
  error,
  onClearError,
}: {
  name: string;
  setName: (n: string) => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
  inviteCode: string;
  onCancelInvite: () => void;
  loadingPhase: "creating" | "joining" | null;
  error: string | null;
  onClearError: () => void;
}) {
  const [codeInput, setCodeInput] = useState("");
  const [showJoin, setShowJoin] = useState(false);
  const validName = isValidClientName(name.trim());
  const loading = loadingPhase !== null;

  return (
    <div className="container" style={{ justifyContent: "center" }}>
      <div className="header">
        <h1>💣 数字炸弹</h1>
        <p className="subtitle">
          {inviteCode ? `邀请你加入房间 ${inviteCode}` : "猜中数字和位置，先找出对方的四位密码"}
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label
            htmlFor="player-name"
            style={{
              display: "block",
              fontSize: 13,
              color: "var(--text-dim)",
              marginBottom: 6,
            }}
          >
            你的昵称
          </label>
          <input
            id="player-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 16))}
            placeholder="1~16 个字符"
            maxLength={16}
            style={{
              width: "100%",
              padding: "12px 16px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 16,
            }}
          />
        </div>

        {!validName && (
          <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>
            先填写昵称，再{inviteCode ? "加入房间" : "创建或加入房间"}
          </p>
        )}

        {inviteCode ? (
          <>
            <button
              className="btn btn-primary"
              onClick={() => onJoin(inviteCode)}
              disabled={loading || !validName}
            >
              {loadingPhase === "joining" ? "加入中…" : `加入房间 ${inviteCode}`}
            </button>
            <button className="btn btn-secondary" onClick={onCancelInvite} disabled={loading}>
              返回首页
            </button>
          </>
        ) : (
          <button
            className="btn btn-primary"
            onClick={onCreate}
            disabled={loading || !validName}
          >
            {loadingPhase === "creating" ? "创建中…" : "创建房间"}
          </button>
        )}

        {!inviteCode && (!showJoin ? (
          <button
            className="btn btn-secondary"
            onClick={() => setShowJoin(true)}
            disabled={!validName}
          >
            输入房间码加入
          </button>
        ) : (
          <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={codeInput}
                onChange={(e) =>
                  setCodeInput(e.target.value.toUpperCase().slice(0, 6))
                }
                placeholder="6 位房间码"
                maxLength={6}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--text)",
                  fontSize: 18,
                  letterSpacing: 4,
                  textAlign: "center",
                  textTransform: "uppercase",
                }}
              />
              <button
                className="btn btn-primary"
                style={{ width: "auto", padding: "12px 20px" }}
                onClick={() => codeInput.length === 6 && onJoin(codeInput)}
                disabled={loading || !validName || codeInput.length !== 6}
              >
                加入
              </button>
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => setShowJoin(false)}
            >
              取消
            </button>
          </div>
        ))}
      </div>

      {error && <Toast message={error} onDismiss={onClearError} />}
    </div>
  );
}

// ─── 房间主屏幕 ───

function RoomScreen({
  roomState,
  playerId,
  sendCommand,
  sendPresence,
  sendInteraction,
  goHome,
  connection,
  error,
  onClearError,
  notice,
  onClearNotice,
}: {
  roomState: PublicRoomView;
  playerId: string;
  playerName: string;
  sendCommand: <T extends string, P>(type: T, payload: P) => void;
  sendPresence: (activity: PlayerActivity) => void;
  sendInteraction: (interaction: InteractionKind) => void;
  goHome: () => void;
  connection: ConnectionState;
  error: string | null;
  onClearError: () => void;
  notice: string | null;
  onClearNotice: () => void;
}) {
  const me = roomState.players.find((p) => p.id === playerId);
  const opponent = roomState.players.find((p) => p.id !== playerId);
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000); };

  // 根据阶段渲染不同界面
  const phase = roomState.phase;

  const shareRoom = async () => {
    const url = `${location.origin}/r/${roomState.roomCode}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "数字炸弹", text: `来玩数字炸弹！房间码: ${roomState.roomCode}`, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await navigator.clipboard.writeText(url).catch(() => {});
    showToast("邀请链接已复制");
  };

  return (
    <div className="container">
      {/* 连接状态 */}
      {connection !== "connected" && (
        <div className="connection-bar reconnecting">
          {connection === "connecting" ? "正在连接…" : "网络波动，正在重连…"}
        </div>
      )}

      {/* 头部 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", letterSpacing: 1 }}>
              {roomState.roomCode}
            </span>
            <button
              style={{ fontSize: 11, color: "var(--text-dim)", padding: "2px 8px", background: "var(--surface)", borderRadius: 6, border: "1px solid var(--border)" }}
              onClick={() => { navigator.clipboard.writeText(roomState.roomCode); showToast("房间码已复制"); }}
            >
              复制
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-secondary" style={{ width: "auto", padding: "6px 12px", fontSize: 13 }} onClick={shareRoom}>
            分享
          </button>
          <button className="btn btn-secondary" style={{ width: "auto", padding: "6px 12px", fontSize: 13 }} onClick={goHome}>
            离开
          </button>
        </div>
      </div>

      {/* 玩家状态 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        {roomState.players.map((p) => (
          <PlayerSeat
            key={p.id}
            player={p}
            isMe={p.id === playerId}
            phase={roomState.phase}
            isCurrentTurn={
              roomState.phase === "playing" &&
              roomState.currentGame?.currentPlayerId === p.id
            }
          />
        ))}
        {roomState.players.length < 2 && (
          <div className="card" style={{ textAlign: "center", color: "var(--text-dim)", padding: "24px" }}>
            <p>等待对方加入…</p>
            <p style={{ fontSize: 13, marginTop: 8 }}>
              分享房间码或链接给对方
            </p>
          </div>
        )}
      </div>

      {/* 按阶段渲染 */}
      {phase === "waiting" && <WaitingPhase roomCode={roomState.roomCode} onShare={shareRoom} onCopy={() => showToast("房间码已复制")} />}
      {phase === "preparing" && (
        <PreparePhase
          me={me}
          opponent={opponent}
          sendCommand={sendCommand}
          sendPresence={sendPresence}
          roomState={roomState}
        />
      )}
      {phase === "playing" && roomState.currentGame && (
        <PlayingPhase
          game={roomState.currentGame}
          me={me}
          opponent={opponent}
          playerId={playerId}
          sendCommand={sendCommand}
          sendPresence={sendPresence}
          sendInteraction={sendInteraction}
        />
      )}
      {phase === "finished" && roomState.currentGame && (
        <FinishedPhase
          game={roomState.currentGame}
          players={roomState.players}
          rematchReady={roomState.rematchReadyPlayerIds}
          playerId={playerId}
          sendCommand={sendCommand}
          sendInteraction={sendInteraction}
          completedGames={roomState.completedGames}
        />
      )}

      {error && <Toast message={error} onDismiss={onClearError} />}
      {notice && <Toast message={notice} onDismiss={onClearNotice} />}
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}

// ─── 等待阶段 ───

function WaitingPhase({ roomCode, onShare, onCopy }: { roomCode: string; onShare: () => void; onCopy?: () => void }) {
  return (
    <div style={{ textAlign: "center", padding: "12px 0" }}>
      <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8 }}>房间码</p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <p style={{ fontSize: 32, fontWeight: 700, letterSpacing: 4, color: "var(--text)", margin: 0 }}>{roomCode}</p>
        <button
          style={{ fontSize: 12, color: "var(--text-dim)", padding: "4px 10px", background: "var(--surface)", borderRadius: 6, border: "1px solid var(--border)" }}
          onClick={() => { navigator.clipboard.writeText(roomCode); if (onCopy) onCopy(); }}
        >
          复制
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 10 }}>把这串码发给朋友</p>
      <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onShare}>
        分享邀请链接
      </button>
    </div>
  );
}

// ─── 准备阶段 ───

function PreparePhase({
  me,
  opponent,
  sendCommand,
  sendPresence,
  roomState,
}: {
  me: PublicPlayer | undefined;
  opponent: PublicPlayer | undefined;
  sendCommand: <T extends string, P>(type: T, payload: P) => void;
  sendPresence: (activity: PlayerActivity) => void;
  roomState: PublicRoomView;
}) {
  const [secretInput, setSecretInput] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const isReady = me?.ready ?? false;

  const handleSecretChange = (val: string) => {
    const filtered = val.replace(/\D/g, "").slice(0, 4);
    setSecretInput(filtered);
    sendPresence(filtered ? "typing" : "thinking");
  };

  const submitReady = () => {
    if (secretInput.length !== 4) return;
    sendPresence("idle");
    sendCommand("ready.set", { secret: secretInput });
  };

  const cancelReady = () => {
    sendCommand("ready.unset", {} as Record<string, never>);
    sendPresence("thinking");
    setSecretInput("");
  };

  const prevLoser = roomState.previousLoserId;
  const loserName = roomState.players.find((p) => p.id === prevLoser)?.name;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      {prevLoser && (
        <div className="card" style={{ width: "100%", textAlign: "center", fontSize: 13, color: "var(--text-dim)", padding: "8px 12px" }}>
          上一局 {loserName} 先手
        </div>
      )}

      <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>设置你的四位密码</p>

      {isReady ? (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, color: "var(--success)", fontWeight: 600 }}>已准备</div>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 6, margin: "4px 0 8px" }}>
            {showSecret ? (me?.secret || "****") : "****"}
          </div>
          <button
            style={{ fontSize: 12, color: "var(--text-dim)", padding: "2px 8px", background: "var(--surface)", borderRadius: 6, border: "1px solid var(--border)" }}
            onClick={() => setShowSecret(!showSecret)}
          >
            {showSecret ? "隐藏" : "显示"}
          </button>
          <button className="btn btn-secondary" style={{ maxWidth: 280, margin: "12px auto 0" }} onClick={cancelReady}>
            取消准备
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, width: "100%", maxWidth: 300 }}>
          <input
            type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4}
            value={secretInput} onChange={(e) => handleSecretChange(e.target.value)}
            placeholder="输入 4 位密码" autoFocus
            className="digit-input"
          />
          <button className="btn btn-primary" onClick={submitReady} disabled={secretInput.length !== 4} style={{ width: "100%" }}>
            {secretInput.length === 4 ? `密码 ${secretInput}` : `还需 ${4 - secretInput.length} 位`}
          </button>
        </div>
      )}

      {opponent && (
        <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>
          {opponent.ready ? `${opponent.name} 已准备` : `等待 ${opponent.name} 准备…`}
        </p>
      )}
    </div>
  );
}

// ─── 游戏阶段 ───

function PlayingPhase({
  game,
  me,
  opponent,
  playerId,
  sendCommand,
  sendPresence,
  sendInteraction,
}: {
  game: PublicGame;
  me: PublicPlayer | undefined;
  opponent: PublicPlayer | undefined;
  playerId: string;
  sendCommand: <T extends string, P>(type: T, payload: P) => void;
  sendPresence: (activity: PlayerActivity) => void;
  sendInteraction: (interaction: InteractionKind) => void;
}) {
  const [guessInput, setGuessInput] = useState("");
  const [showMySecret, setShowMySecret] = useState(false);
  const guessInputRef = useRef<HTMLInputElement | null>(null);
  const isMyTurn = game.currentPlayerId === playerId;
  const turnStartedAt = game.turns.at(-1)?.createdAt ?? game.startedAt;
  const elapsed = useElapsedSeconds(turnStartedAt);

  useEffect(() => {
    sendPresence(isMyTurn ? "thinking" : "idle");
    if (isMyTurn) {
      setGuessInput("");
      const frame = requestAnimationFrame(() => guessInputRef.current?.focus());
      return () => {
        cancelAnimationFrame(frame);
        sendPresence("idle");
      };
    }
    return () => sendPresence("idle");
  }, [isMyTurn, sendPresence]);

  const handleGuessChange = (val: string) => {
    const filtered = val.replace(/\D/g, "").slice(0, 4);
    setGuessInput(filtered);
    sendPresence(filtered ? "typing" : "thinking");
  };

  const submitGuess = () => {
    if (guessInput.length !== 4 || !isMyTurn) return;
    sendPresence("idle");
    sendCommand("guess.submit", { guess: guessInput });
    setGuessInput("");
  };

  const allTurns = game.turns;
  const rounds = groupTurnsIntoRounds(allTurns);
  const currentRound = Math.floor(allTurns.length / 2) + 1;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ textAlign: "center" }}>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          第 {game.gameNumber} 局 · 第 {currentRound} 轮
        </span>
      </div>

      {/* 我的密码 + 眼睛 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "4px 0" }}>
        <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: 4 }}>
          {showMySecret ? (me?.secret || "****") : "****"}
        </span>
        <button
          style={{ fontSize: 11, color: "var(--text-dim)", padding: "2px 6px", background: "var(--surface)", borderRadius: 4, border: "1px solid var(--border)" }}
          onClick={() => setShowMySecret(!showMySecret)}
        >
          {showMySecret ? "隐藏" : "查看密码"}
        </button>
      </div>

      <div style={{ textAlign: "center", fontSize: 16, fontWeight: 600 }}>
        {isMyTurn ? (
          <span style={{ color: "var(--accent-1)" }}>轮到你猜了</span>
        ) : (
          <span style={{ color: "var(--text-dim)" }}>
            {opponent?.activity === "typing"
              ? `${opponent.name} 正在输入…`
              : `等待 ${opponent?.name || "对方"}猜测 · ${elapsed}s`}
          </span>
        )}
      </div>

      {!isMyTurn && elapsed >= 10 && (
        <button className="btn btn-secondary nudge-button" onClick={() => sendInteraction("nudge")}>
          👀 轻轻催一下
        </button>
      )}

      {isMyTurn && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, width: "100%", maxWidth: 300, margin: "0 auto" }}>
          <input
            key={`${game.gameNumber}-${game.turns.length}`}
            ref={guessInputRef}
            type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4}
            value={guessInput} onChange={(e) => handleGuessChange(e.target.value)}
            onFocus={() => sendPresence(guessInput ? "typing" : "thinking")}
            onBlur={() => sendPresence("idle")}
            placeholder="输入 4 位数字" autoFocus
            className="digit-input"
          />
          <button className="btn btn-primary" onClick={submitGuess} disabled={guessInput.length !== 4} style={{ width: "100%" }}>
            {guessInput.length === 4 ? `就猜 ${guessInput}` : `${4 - guessInput.length} 位待输入`}
          </button>
        </div>
      )}

      {/* 双方历史 */}
      <div className="history-panel">
        {rounds.length > 0 ? (
          <div className="turn-history">
            {[...rounds].reverse().map((round) => (
              <div key={round.ro} className="round-group">
                <div className="round-label">第 {round.ro} 轮</div>
                {round.turns.map((t) => {
                  const p = t.playerId === me?.id ? me : opponent;
                  return (
                    <div key={t.turnNumber} className="turn-row">
                      <span className="player-name" style={{ fontSize: 13 }}>{p?.name || "?"}</span>
                      <span className="guess-num" style={{ fontSize: 13 }}>{t.guess}</span>
                      <span className={`hits hits-${t.hits}`} style={{ fontSize: 13 }}>{hitsText(t.hits)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className="history-empty">第一条猜测会出现在这里</div>
        )}
      </div>
    </div>
  );
}

function groupTurnsIntoRounds(
  turns: NonNullable<PublicRoomView["currentGame"]>["turns"],
) {
  const results: { ro: number; turns: typeof turns }[] = [];
  let ro = 1;
  let idx = 0;
  while (idx < turns.length) {
    const roundTurns = [];
    roundTurns.push(turns[idx]!);
    idx++;
    // 如果下一 turn 是另一方，加入同一轮
    if (idx < turns.length && turns[idx]!.playerId !== turns[idx - 1]!.playerId) {
      roundTurns.push(turns[idx]!);
      idx++;
    }
    results.push({ ro, turns: roundTurns });
    ro++;
  }
  return results;
}

function hitsText(hits: number): string {
  switch (hits) {
    case 0: return "一个没中";
    case 1: return "命中 1 位";
    case 2: return "命中 2 位";
    case 3: return "只差 1 位";
    case 4: return "全部命中!";
    default: return `${hits}`;
  }
}

function useElapsedSeconds(startedAt: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

function guessInsight(game: PublicGame, playerId: string): { text: string; interaction: InteractionKind } {
  const guesses = game.turns.filter((turn) => turn.playerId === playerId);
  if (game.winnerPlayerId === playerId) {
    return { text: `你用了 ${guesses.length} 次猜中，对方最后还是被你拆穿了。`, interaction: "nice" };
  }
  const best = guesses.reduce((current, turn) => turn.hits > current.hits ? turn : current, guesses[0] ?? { hits: 0, guess: "" });
  if (best.hits === 3) {
    return { text: `你猜 ${best.guess} 时已经命中 3 位——真的就差一点。`, interaction: "almost" };
  }
  if (best.hits === 2) {
    return { text: `你最好的一次是 ${best.guess}，已经锁定了一半位置。`, interaction: "almost" };
  }
  return { text: guesses.length ? "这局线索藏得很深，下一局换个起手也许就破了。" : "还没来得及出手，下一局把机会抢回来。", interaction: "rematch" };
}

// ─── 结算阶段 ───

function FinishedPhase({
  game,
  players,
  rematchReady,
  playerId,
  sendCommand,
  sendInteraction,
  completedGames,
}: {
  game: NonNullable<PublicRoomView["currentGame"]>;
  players: PublicPlayer[];
  rematchReady: string[];
  playerId: string;
  sendCommand: <T extends string, P>(type: T, payload: P) => void;
  sendInteraction: (interaction: InteractionKind) => void;
  completedGames: PublicRoomView["completedGames"];
}) {
  const winner = players.find((p) => p.id === game.winnerPlayerId);
  const loser = players.find((p) => p.id === game.loserPlayerId);
  const myReady = rematchReady.includes(playerId);
  const opponentReady = rematchReady.some((id) => id !== playerId);

  const myGuesses = game.turns.filter((t) => t.playerId === playerId).length;
  const oppGuesses = game.turns.filter((t) => t.playerId !== playerId).length;
  const insight = guessInsight(game, playerId);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 结果 */}
      <div style={{ textAlign: "center", padding: "12px 0" }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: "var(--success)", marginBottom: 4 }}>
          {winner?.name || "?"} 赢了
        </div>
        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>
          我猜了 {myGuesses} 次 · 对手猜了 {oppGuesses} 次
        </p>
      </div>

      <div className="insight-card">
        <div className="insight-label">这局复盘</div>
        <div>{insight.text}</div>
        <button className="reaction-chip" onClick={() => sendInteraction(insight.interaction)}>
          {insight.interaction === "almost" ? "发给对方：我就差一点 😤" : "把这句发给对方"}
        </button>
      </div>

      {/* 公开秘密 */}
      <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
        {players.map((p) => (
          <div key={p.id} className="card" style={{ textAlign: "center", flex: 1, maxWidth: 180 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{p.name}</div>
            <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 4, fontVariantNumeric: "tabular-nums" }}>
              {p.secret}
            </div>
          </div>
        ))}
      </div>

      {/* 再来一局 */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        {!myReady ? (
          <button
            className="btn btn-primary"
            style={{ minWidth: 200 }}
            onClick={() => {
              sendCommand("rematch.set", { ready: true });
              sendInteraction("rematch");
            }}
          >
            再来一局
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 14, color: "var(--success)" }}>你已准备</div>
            <button
              className="btn btn-secondary"
              style={{ minWidth: 160 }}
              onClick={() => sendCommand("rematch.set", { ready: false })}
            >
              取消
            </button>
          </div>
        )}
        {opponentReady && (
          <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>
            对方也已准备，即将开始…
          </p>
        )}
      </div>

      {/* 历史战绩 */}
      {completedGames.length > 0 && (
        <div style={{ overflow: "auto" }}>
          <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8 }}>历史战绩</p>
          {completedGames.map((g) => {
            const w = players.find((p) => p.id === g.winnerPlayerId);
            return (
              <div key={g.gameNumber} className="card" style={{ marginBottom: 8, padding: "12px 16px", fontSize: 14 }}>
                第 {g.gameNumber} 局 · {w?.name || "?"} 胜 · {g.turns.length} 回合
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 玩家座位 ───

function PlayerSeat({
  player,
  isMe,
  phase,
  isCurrentTurn,
}: {
  player: PublicPlayer;
  isMe: boolean;
  phase: string;
  isCurrentTurn: boolean;
}) {
  const statusText = () => {
    if (!player.connected) return "暂时离开";
    if (player.activity === "typing") return "正在输入";
    if (player.activity === "thinking") return "正在思考";
    if (phase === "preparing" && player.ready) return "已准备";
    if (phase === "playing" && isCurrentTurn) return "思考中";
    if (phase === "playing") return "等待中";
    return "";
  };

  return (
    <div
      className="player-seat"
      style={{
        borderColor: isCurrentTurn ? "var(--accent-1)" : "var(--border)",
      }}
    >
      <span className={`dot ${player.connected ? "online" : "offline"}`} />
      <span className="name" style={{ fontSize: 13 }}>
        {player.name}
        {isMe ? " (你)" : ""}
      </span>
      {statusText() && (
        <span className="status" style={{ fontSize: 11, color: player.ready ? "var(--success)" : "var(--text-dim)" }}>
          {statusText()}
        </span>
      )}
    </div>
  );
}

// ─── Toast ───

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  return (
    <div className="toast" onClick={onDismiss}>
      {message}
    </div>
  );
}
