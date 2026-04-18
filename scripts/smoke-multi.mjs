// Quick end-to-end smoke test for the multiplayer Socket.IO server.
//
// Spawns two clients (host + guest), creates a room, joins, sets host song,
// transitions through loading + countdown, and verifies snapshots fan out
// to every member of the room.
//
// Usage:  node scripts/smoke-multi.mjs            (assumes server on :3004)
//         SYNCLE_URL=http://localhost:3000 node scripts/smoke-multi.mjs

import { io } from "socket.io-client";

const URL = process.env.SYNCLE_URL ?? "http://localhost:3004";
const TIMEOUT = 15_000;

function fail(msg) {
  console.error(`\n[smoke] FAIL: ${msg}`);
  process.exit(1);
}

function makeClient(label) {
  const sock = io(URL, {
    transports: ["websocket", "polling"],
    reconnection: false,
    timeout: TIMEOUT,
  });
  sock.on("connect_error", (err) => fail(`${label} connect_error: ${err.message}`));
  sock.on("error", (payload) => console.warn(`[smoke:${label}] server error`, payload));
  if (process.env.SMOKE_VERBOSE) {
    sock.on("room:snapshot", (s) =>
      console.log(`[smoke:${label}] snapshot phase=${s.phase} song=${s.selectedSong?.beatmapsetId}`),
    );
    sock.on("room:notice", (n) =>
      console.log(`[smoke:${label}] notice ${n.kind}: ${n.text}`),
    );
  }
  return sock;
}

function ack(sock, event, payload) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), TIMEOUT);
    sock.emit(event, payload, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

function waitFor(sock, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`waitFor ${event} timeout`)),
      TIMEOUT,
    );
    const handler = (payload) => {
      if (predicate(payload)) {
        clearTimeout(t);
        sock.off(event, handler);
        resolve(payload);
      }
    };
    sock.on(event, handler);
  });
}

/**
 * Buffered "wait until the latest snapshot matches predicate". Avoids the
 * classic race where socket.io delivers the event before we attach a one-shot
 * listener. Buffers snapshots from connect-time and replays them on demand.
 */
function makeSnapshotWaiter(sock) {
  let latest = null;
  const waiters = [];
  sock.on("room:snapshot", (snap) => {
    latest = snap;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.predicate(snap)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(snap);
      }
    }
  });
  return (predicate) =>
    new Promise((resolve, reject) => {
      if (latest && predicate(latest)) return resolve(latest);
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error("waitForSnapshot timeout"));
      }, TIMEOUT);
      waiters.push({ predicate, resolve, timer });
    });
}

async function main() {
  console.log(`[smoke] connecting to ${URL}`);
  const host = makeClient("host");
  const guest = makeClient("guest");

  await Promise.all([
    new Promise((r) => host.once("connect", r)),
    new Promise((r) => guest.once("connect", r)),
  ]);
  console.log("[smoke] both sockets connected");

  // Buffer snapshots from t=0 so we never miss one to a listener race.
  const hostSnap = makeSnapshotWaiter(host);
  const guestSnap = makeSnapshotWaiter(guest);

  // 1. host creates a room
  const createRes = await ack(host, "room:create", { name: "Alice" });
  if (!createRes?.ok) fail(`room:create: ${createRes?.message}`);
  const code = createRes.data.code;
  const hostSession = createRes.data.sessionId;
  console.log(`[smoke] room created: ${code}  hostSession=${hostSession}`);

  // 2. wait for snapshot showing host as the only player
  const hostFirstSnap = await hostSnap(
    (s) => s.code === code && s.players.length === 1,
  );
  if (hostFirstSnap.hostId !== hostSession) {
    fail(
      `hostId (${hostFirstSnap.hostId}) should equal host sessionId (${hostSession})`,
    );
  }
  if (hostFirstSnap.phase !== "lobby") {
    fail(`expected lobby, got ${hostFirstSnap.phase}`);
  }
  console.log("[smoke] host owns room and is in lobby phase");

  // 3. guest joins
  const joinRes = await ack(guest, "room:join", { code, name: "Bob" });
  if (!joinRes?.ok) fail(`room:join: ${joinRes?.message}`);

  const [twoPlayers, guestTwoPlayers] = await Promise.all([
    hostSnap((s) => s.players.length === 2),
    guestSnap((s) => s.players.length === 2),
  ]);
  console.log(
    `[smoke] guest joined, roster: ${twoPlayers.players
      .map((p) => `${p.name}${p.isHost ? "(host)" : ""}`)
      .join(", ")}`,
  );
  if (guestTwoPlayers.code !== code) fail("guest snapshot has wrong code");

  // 4. host announces a song.
  const song = {
    beatmapsetId: 41823,
    title: "Smoke Test Track",
    artist: "Syncle CI",
    source: "smoke-test",
  };
  const songMatch = (s) => s.selectedSong?.beatmapsetId === song.beatmapsetId;
  host.emit("host:selectSong", song);
  const [songSnap, guestSongSnap] = await Promise.all([
    hostSnap(songMatch),
    guestSnap(songMatch),
  ]);
  console.log(`[smoke] selected song: ${songSnap.selectedSong?.title}`);
  if (guestSongSnap.selectedSong?.title !== song.title) {
    fail("guest didn't receive song selection");
  }

  // 5. host kicks off loading phase. Listeners first, then emit.
  const pHostLoading = waitFor(host, "phase:loading");
  const pGuestLoading = waitFor(guest, "phase:loading");
  host.emit("host:start", { mode: "easy" });
  const [hostLoading, guestLoading] = await Promise.all([
    pHostLoading,
    pGuestLoading,
  ]);
  if (hostLoading.mode !== "easy" || guestLoading.mode !== "easy") {
    fail("phase:loading mode mismatch");
  }
  if (typeof hostLoading.deadline !== "number") fail("missing loading deadline");
  console.log(
    `[smoke] phase:loading delivered to both clients, deadline=${new Date(
      hostLoading.deadline,
    ).toISOString()}`,
  );

  // 6. cancel back to lobby (don't actually run a song in CI)
  host.emit("host:cancelLoading");
  await hostSnap((s) => s.phase === "lobby" && s.selectedSong !== null);
  console.log("[smoke] host cancelled loading; back to lobby");

  // 7. tear down
  host.disconnect();
  guest.disconnect();
  console.log("\n[smoke] PASS ✓ multiplayer handshake + lobby transitions work");
  process.exit(0);
}

main().catch((err) => fail(err?.message ?? String(err)));
