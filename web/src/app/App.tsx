// ─── 主应用 ───

import React, { useState, useCallback, useEffect, useRef } from "react";
import type { PublicRoomView, PublicPlayer, PublicCause, PublicGame } from "../../../src/shared/domain.js";
import { GameTransport } from "../transport/http.js";

const API = "/api";

type AppPhase = "home" | "creating" | "joining" | "in-room";

type AppState = {
  phase: AppPhase;
  roomCode: string;
  playerToken: string;
  playerId: string;
  name: string;
  roomState: PublicRoomView | null;
  error: string | null;
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

export default function App() {
  const [state, setState] = useState<AppState>({
    phase: "home",
    roomCode: "",
    playerToken: "",
    playerId: "",
    name: loadStorage()["_lastName"]?.name || "",
    roomState: null,
    error: null,
  });

  const transportRef = useRef<GameTransport | null>(null);

  // ─── 处理服务端消息 ───



  // ─── 创建房间 ───

  const createRoom = useCallback(async () => {
    setState((s) => ({ ...s, phase: "creating", error: null }));

    const name = state.name || "玩家";
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
        roomUrl?: string;
        error?: { code: string; message: string };
      };

      if (data.error) {
        setState((s) => ({ ...s, error: data.error!.message, phase: "home" }));
        return;
      }

      saveStorage(data.roomCode, data.playerToken, name);
      saveStorage("_lastName", "", name);

      const t = new GameTransport(data.roomCode, data.playerToken, {
        onState: (s) => setState((prev) => ({ ...prev, roomState: s, phase: "in-room" })),
        onError: (code, msg) => setState((prev) => ({ ...prev, error: msg })),
      });

      transportRef.current = t;

      setState((s) => ({
        ...s,
        phase: "in-room",
        roomCode: data.roomCode,
        playerToken: data.playerToken,
        playerId: data.playerId,
      }));

      await t.connect();
    } catch (err) {
      setState((s) => ({
        ...s,
        error: "创建房间失败，请重试",
        phase: "home",
      }));
    }
  }, [state.name]);

  // ─── 加入房间 ───

  const joinRoom = useCallback(async (code: string, name: string) => {
    setState((s) => ({ ...s, phase: "joining", error: null }));

    const storage = loadStorage();
    const saved = storage[code];

    try {
      const resp = await fetch(`${API}/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
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
        setState((s) => ({ ...s, error: data.error!.message, phase: "home" }));
        return;
      }

      const finalToken = saved?.token || data.playerToken;
      saveStorage(code, finalToken, name);
      saveStorage("_lastName", "", name);

      const t = new GameTransport(code, finalToken, {
        onState: (s) => setState((prev) => ({ ...prev, roomState: s, phase: "in-room" })),
        onError: (code, msg) => setState((prev) => ({ ...prev, error: msg })),
      });

      transportRef.current = t;

      setState((s) => ({
        ...s,
        phase: "in-room",
        roomCode: code,
        playerToken: finalToken,
        playerId: data.playerId || data.roomState.players.find(
          (p) => p.name === name,
        )?.id || "",
      }));

      await t.connect();
    } catch {
      setState((s) => ({ ...s, error: "加入失败，检查房间码", phase: "home" }));
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

  // ─── 返回首页 ───

  const goHome = useCallback(() => {
    transportRef.current?.disconnect();
    transportRef.current = null;
    setState((s) => ({
      ...s,
      phase: "home",
      roomCode: "",
      roomState: null,
      error: null,
    }));
  }, []);

  // ─── 从 URL 检测房间码 ───

  useEffect(() => {
    const match = location.pathname.match(/^\/r\/([A-HJ-NP-Z2-9]{6})$/i);
    if (match && state.phase === "home") {
      const code = match[1]!.toUpperCase();
      joinRoom(code, state.name || "玩家");
    }
  }, [state.phase, state.name, joinRoom]);

  // ─── 前台恢复 ───

  // ─── 渲染 ───

  if (state.phase === "in-room" && state.roomState) {
    return (
      <RoomScreen
        roomState={state.roomState}
        playerId={state.playerId}
        playerName={state.name}
        sendCommand={sendCommand}
        goHome={goHome}
        error={state.error}
        onClearError={() => setState((s) => ({ ...s, error: null }))}
      />
    );
  }

  return (
    <HomeScreen
      name={state.name}
      setName={(n) => setState((s) => ({ ...s, name: n }))}
      onCreate={createRoom}
      onJoin={(code) => joinRoom(code, state.name || "玩家")}
      loading={state.phase !== "home"}
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

// ─── 首页 ───

function HomeScreen({
  name,
  setName,
  onCreate,
  onJoin,
  loading,
  error,
  onClearError,
}: {
  name: string;
  setName: (n: string) => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
  loading: boolean;
  error: string | null;
  onClearError: () => void;
}) {
  const [codeInput, setCodeInput] = useState("");
  const [showJoin, setShowJoin] = useState(false);

  return (
    <div className="container" style={{ justifyContent: "center" }}>
      <div className="header">
        <h1>💣 数字炸弹</h1>
        <p className="subtitle">猜中数字和位置，先找出对方的四位密码</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label
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

        <button
          className="btn btn-primary"
          onClick={onCreate}
          disabled={loading}
        >
          {loading ? "创建中…" : "创建房间"}
        </button>

        {!showJoin ? (
          <button
            className="btn btn-secondary"
            onClick={() => setShowJoin(true)}
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
                disabled={loading || codeInput.length !== 6}
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
        )}
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
  goHome,
  reconnecting,
  error,
  lastCause,
  onClearError,
}: {
  roomState: PublicRoomView;
  playerId: string;
  playerName: string;
  sendCommand: <T extends string, P>(type: T, payload: P) => void;
  goHome: () => void;
  reconnecting: boolean;
  error: string | null;
  lastCause: PublicCause | null;
  onClearError: () => void;
}) {
  const isCreator = roomState.players[0]?.id === playerId;
  const me = roomState.players.find((p) => p.id === playerId);
  const opponent = roomState.players.find((p) => p.id !== playerId);

  // 根据阶段渲染不同界面
  const phase = roomState.phase;

  const shareRoom = () => {
    const url = `${location.origin}/r/${roomState.roomCode}`;
    navigator.clipboard.writeText(url).catch(() => {});
    if (navigator.share) {
      navigator.share({ title: "数字炸弹", text: `来玩数字炸弹！房间码: ${roomState.roomCode}`, url });
    }
  };

  return (
    <div className="container">
      {/* 连接状态 */}
      {reconnecting && (
        <div className="connection-bar reconnecting">重新连接中…</div>
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
              onClick={() => navigator.clipboard.writeText(roomState.roomCode)}
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
      {phase === "waiting" && <WaitingPhase roomCode={roomState.roomCode} onShare={shareRoom} />}
      {phase === "preparing" && (
        <PreparePhase
          me={me}
          opponent={opponent}
          sendCommand={sendCommand}
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
          lastCause={lastCause}
        />
      )}
      {phase === "finished" && roomState.currentGame && (
        <FinishedPhase
          game={roomState.currentGame}
          players={roomState.players}
          rematchReady={roomState.rematchReadyPlayerIds}
          playerId={playerId}
          sendCommand={sendCommand}
          completedGames={roomState.completedGames}
        />
      )}

      {error && <Toast message={error} onDismiss={onClearError} />}
    </div>
  );
}

// ─── 等待阶段 ───

function WaitingPhase({ roomCode, onShare }: { roomCode: string; onShare: () => void }) {
  return (
    <div style={{ textAlign: "center", padding: "12px 0" }}>
      <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8 }}>房间码</p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <p style={{ fontSize: 32, fontWeight: 700, letterSpacing: 4, color: "var(--text)", margin: 0 }}>{roomCode}</p>
        <button
          style={{ fontSize: 12, color: "var(--text-dim)", padding: "4px 10px", background: "var(--surface)", borderRadius: 6, border: "1px solid var(--border)" }}
          onClick={() => navigator.clipboard.writeText(roomCode)}
        >
          复制
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 10 }}>把这串码发给朋友</p>
      <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onShare}>
        复制邀请链接
      </button>
    </div>
  );
}

// ─── 准备阶段 ───

function PreparePhase({
  me,
  opponent,
  sendCommand,
  roomState,
}: {
  me: PublicPlayer | undefined;
  opponent: PublicPlayer | undefined;
  sendCommand: <T extends string, P>(type: T, payload: P) => void;
  roomState: PublicRoomView;
}) {
  const [secretInput, setSecretInput] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const isReady = me?.ready ?? false;

  const handleSecretChange = (val: string) => {
    const filtered = val.replace(/\D/g, "").slice(0, 4);
    setSecretInput(filtered);
  };

  const submitReady = () => {
    if (secretInput.length !== 4) return;
    sendCommand("ready.set", { secret: secretInput });
  };

  const cancelReady = () => {
    sendCommand("ready.unset", {} as Record<string, never>);
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
}: {
  game: PublicGame;
  me: PublicPlayer | undefined;
  opponent: PublicPlayer | undefined;
  playerId: string;
  sendCommand: <T extends string, P>(type: T, payload: P) => void;
}) {
  const [guessInput, setGuessInput] = useState("");
  const [showMySecret, setShowMySecret] = useState(false);
  const isMyTurn = game.currentPlayerId === playerId;

  const handleGuessChange = (val: string) => {
    const filtered = val.replace(/\\D/g, "").slice(0, 4);
    setGuessInput(filtered);
  };

  const submitGuess = () => {
    if (guessInput.length !== 4 || !isMyTurn) return;
    sendCommand("guess.submit", { guess: guessInput });
    setGuessInput("");
  };

  const myTurns = game.turns.filter(t => t.playerId === playerId);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ textAlign: "center" }}>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          第 {game.gameNumber} 局 · 第 {myTurns.length + 1} 轮
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
          <span style={{ color: "var(--text-dim)" }}>等待对方猜测…</span>
        )}
      </div>

      {isMyTurn && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, width: "100%", maxWidth: 300, margin: "0 auto" }}>
          <input
            type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4}
            value={guessInput} onChange={(e) => handleGuessChange(e.target.value)}
            placeholder="输入 4 位数字" autoFocus
            className="digit-input"
          />
          <button className="btn btn-primary" onClick={submitGuess} disabled={guessInput.length !== 4} style={{ width: "100%" }}>
            {guessInput.length === 4 ? `就猜 ${guessInput}` : `${4 - guessInput.length} 位待输入`}
          </button>
        </div>
      )}

      {myTurns.length > 0 && (
        <div style={{ maxHeight: 180, overflow: "auto", marginTop: 4 }}>
          <div className="turn-history">
            {myTurns.slice().reverse().map((t, i) => (
              <div key={t.turnNumber} className="turn-row">
                <span className="guess-num" style={{ fontSize: 13 }}>第 {myTurns.length - i} 次：猜 {t.guess}</span>
                <span className={`hits hits-${t.hits}`} style={{ fontSize: 13 }}>{hitsText(t.hits)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function groupTurnsIntoRounds(
  turns: NonNullable<PublicRoomView["currentGame"]>["turns"],
  firstPlayerId: string,
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

// ─── 结算阶段 ───

function FinishedPhase({
  game,
  players,
  rematchReady,
  playerId,
  sendCommand,
  completedGames,
}: {
  game: NonNullable<PublicRoomView["currentGame"]>;
  players: PublicPlayer[];
  rematchReady: string[];
  playerId: string;
  sendCommand: <T extends string, P>(type: T, payload: P) => void;
  completedGames: PublicRoomView["completedGames"];
}) {
  const winner = players.find((p) => p.id === game.winnerPlayerId);
  const loser = players.find((p) => p.id === game.loserPlayerId);
  const myReady = rematchReady.includes(playerId);
  const opponentReady = rematchReady.some((id) => id !== playerId);

  const myGuesses = game.turns.filter((t) => t.playerId === playerId).length;
  const oppGuesses = game.turns.filter((t) => t.playerId !== playerId).length;

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
            onClick={() => sendCommand("rematch.set", { ready: true })}
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
    if (!player.connected) return "离线";
    if (phase === "preparing" && player.ready) return "已准备";
    if (phase === "playing" && isCurrentTurn) return "思考中…";
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
      <div className={`dot ${player.connected ? "online" : "offline"}`} />
      <span className="name">
        {player.name}
        {isMe ? "（我）" : ""}
      </span>
      <span className="status">{statusText()}</span>
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
