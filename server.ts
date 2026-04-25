/**
 * Custom Next.js server: boots the framework + a Socket.IO server on the
 * same HTTP listener. Used in BOTH dev and prod so the multiplayer wire
 * format is identical across environments.
 *
 * Why custom server?
 *   - Vercel-style serverless can't hold a long-lived WebSocket. Render /
 *     Railway / Fly.io / a plain VPS run this single Node process and keep
 *     connections alive indefinitely.
 *
 * Run via `tsx` so we don't need a separate compile step:
 *   - dev:   `npm run dev`     → tsx + NODE_ENV=development, hot reload
 *   - prod:  `npm run start`   → tsx + NODE_ENV=production, after `next build`
 *
 * Port: $PORT (Render sets this), else first free port from 3000 upward.
 */

import { createServer } from "node:http";
import next from "next";
import { Server as IOServer } from "socket.io";

import { findFreePort } from "./scripts/dev-utils.mjs";
import { wireSocketServer } from "./lib/server/io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "./lib/multi/protocol";

const dev = process.env.NODE_ENV !== "production";
// Bind to all interfaces by default. Use HOST (not HOSTNAME - which Windows
// pre-populates with the machine name and breaks listen()) to override.
const hostname = process.env.HOST ?? "0.0.0.0";
const portFromEnv = process.env.PORT ? Number(process.env.PORT) : null;

async function main(): Promise<void> {
  const port = portFromEnv ?? (await findFreePort(3000, 50));
  if (port == null) {
    console.error("[syncle] could not bind a free port");
    process.exit(1);
  }

  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new IOServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    {
      // Same-origin in prod (no CORS). Permissive in dev for cross-port
      // testing if you spin up the client elsewhere.
      cors: dev ? { origin: true, credentials: true } : undefined,
      // Faster heartbeat than defaults (25s/20s) so a refresh feels snappy.
      pingInterval: 15_000,
      pingTimeout: 10_000,
      // Hard cap on payload size - score updates are <1 KB; 5 MB protects
      // against a malicious client trying to OOM the server.
      maxHttpBufferSize: 5 * 1024 * 1024,
    },
  );

  wireSocketServer(io);

  httpServer
    .once("error", (err) => {
      console.error("[syncle] http server error:", err);
      process.exit(1);
    })
    .listen(port, hostname, () => {
      const url = `http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`;
      console.log(`[syncle] ${dev ? "dev" : "prod"} server ready at ${url}`);
      console.log(`[syncle] socket.io attached to /socket.io`);
    });

  const shutdown = (sig: string): void => {
    console.log(`[syncle] received ${sig}, shutting down...`);
    io.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[syncle] fatal boot error:", err);
  process.exit(1);
});
