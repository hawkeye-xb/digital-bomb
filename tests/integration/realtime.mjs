import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const script = await readFile(new URL("../../dist/worker-test/index.js", import.meta.url), "utf8");
const mf = new Miniflare({
  modules: true,
  script,
  compatibilityDate: "2026-07-01",
  bindings: { WS_TICKET_SECRET: "integration-test-secret" },
  durableObjects: { ROOMS: { className: "Room", useSQLite: true } },
});

class Inbox {
  messages = [];
  waiters = [];

  push(message) {
    this.messages.push(message);
    this.flush();
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      const index = this.messages.findIndex(waiter.predicate);
      if (index < 0) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(this.messages.splice(index, 1)[0]);
    }
  }

  next(predicate, label) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${label}`));
        }, 3_000),
      };
      this.waiters.push(waiter);
    });
  }
}

async function json(path, init) {
  const response = await mf.dispatchFetch(`http://game.test${path}`, init);
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return body;
}

async function connect(roomCode, token) {
  const { ticket } = await json(`/api/rooms/${roomCode}/socket-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const response = await mf.dispatchFetch(
    `http://game.test/api/rooms/${roomCode}/socket?ticket=${encodeURIComponent(ticket)}`,
    { headers: { Upgrade: "websocket" } },
  );
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  assert.ok(socket);
  const inbox = new Inbox();
  socket.addEventListener("message", (event) => inbox.push(JSON.parse(String(event.data))));
  socket.accept();
  const snapshot = await inbox.next((message) => message.type === "room.snapshot", "initial snapshot");
  return { socket, inbox, state: snapshot.state };
}

function sendCommand(client, type, payload, version) {
  client.socket.send(JSON.stringify({
    type,
    payload,
    expectedVersion: version,
    commandId: crypto.randomUUID(),
  }));
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function nextState(client, causeType) {
  const update = await client.inbox.next(
    (message) => message.type === "room.updated" && message.cause.type === causeType,
    causeType,
  );
  client.state = update.state;
  return update;
}

try {
  const created = await json("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Alice" }),
  });
  assert.equal(created.roomState.players.length, 1);
  assert.equal(created.roomState.viewerPlayerId, created.playerId);
  const joined = await json(`/api/rooms/${created.roomCode}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Bob", tokenHash: "" }),
  });
  const restored = await json(`/api/rooms/${created.roomCode}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Bob", tokenHash: await hashToken(joined.playerToken) }),
  });
  assert.equal(restored.playerId, joined.playerId);
  assert.equal(restored.roomState.players.length, 2);

  const alice = await connect(created.roomCode, created.playerToken);
  const bob = await connect(created.roomCode, joined.playerToken);

  alice.socket.send(JSON.stringify({ type: "presence.update", activity: "typing" }));
  const presence = await bob.inbox.next(
    (message) => message.type === "presence.updated" && message.playerId === created.playerId && message.activity === "typing",
    "typing presence",
  );
  assert.equal(presence.connected, true);

  sendCommand(alice, "ready.set", { secret: "1234" }, alice.state.version);
  await nextState(alice, "ready.changed");
  await nextState(bob, "ready.changed");

  sendCommand(bob, "ready.set", { secret: "5678" }, bob.state.version);
  await nextState(alice, "game.started");
  await nextState(bob, "game.started");

  const clients = new Map([
    [created.playerId, alice],
    [joined.playerId, bob],
  ]);
  for (let turn = 0; turn < 3; turn++) {
    const currentId = alice.state.currentGame.currentPlayerId;
    const current = clients.get(currentId);
    sendCommand(current, "guess.submit", { guess: turn === 2 ? "1111" : "0000" }, current.state.version);
    const [aliceUpdate, bobUpdate] = await Promise.all([
      nextState(alice, "guess.resolved"),
      nextState(bob, "guess.resolved"),
    ]);
    assert.equal(aliceUpdate.state.currentGame.turns.length, turn + 1);
    assert.equal(bobUpdate.state.currentGame.turns.length, turn + 1);
  }

  const senderId = alice.state.currentGame.currentPlayerId;
  const sender = clients.get(senderId);
  const receiver = sender === alice ? bob : alice;
  sender.socket.send(JSON.stringify({ type: "interaction.send", interaction: "nudge" }));
  const interaction = await receiver.inbox.next(
    (message) => message.type === "interaction.received" && message.interaction === "nudge",
    "nudge interaction",
  );
  assert.equal(interaction.fromPlayerId, senderId);

  console.log("Realtime integration passed: 2 clients, presence, 3 alternating guesses, interaction");
  alice.socket.close(1000, "done");
  bob.socket.close(1000, "done");
} finally {
  await mf.dispose();
}
