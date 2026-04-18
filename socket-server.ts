/**
 * Standalone Socket.IO server — does NOT import Next.js.
 *
 * This is the entry point you deploy to Render (or any other persistent-Node
 * host) when running the multiplayer realtime layer separately from the
 * frontend. The Next.js app itself is deployed to Vercel for fast static /
 * serverless delivery, and the browser opens a websocket to THIS server via
 * `NEXT_PUBLIC_SOCKET_URL`.
 *
 * Run via tsx so we don't need a build step:
 *   - dev   : `npm run socket:dev`     (watches lib/server + lib/multi)
 *   - prod  : `npm run socket:start`   (Render's "Start Command")
 *
 * Env:
 *   PORT          - injected by Render. Falls back to 4000 locally so it
 *                   doesn't collide with `npm run dev` (Next + socket on 3004).
 *   HOST          - bind interface. Defaults to 0.0.0.0.
 *   CORS_ORIGINS  - comma-separated list of allowed origins (Vercel URL,
 *                   custom domain, etc). Use "*" to allow any (NOT
 *                   recommended for production). Defaults to "*" to make
 *                   first-deploy frictionless.
 */

import { createServer } from "node:http";
import { Server as IOServer } from "socket.io";

import { wireSocketServer } from "./lib/server/io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "./lib/multi/protocol";

const host = process.env.HOST ?? "0.0.0.0";
const port = process.env.PORT ? Number(process.env.PORT) : 4000;

// Patterns from CORS_ORIGINS. Each entry is one of:
//   - "*"                                  → allow any origin
//   - "https://syncle.vercel.app"          → exact match
//   - "https://*.syncle.vercel.app"        → wildcard subdomain match
//                                            (covers Vercel preview deploys)
const patterns = (process.env.CORS_ORIGINS ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowAny = patterns.length === 0 || patterns.includes("*");

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;             // server-to-server, curl, etc
  if (allowAny) return true;
  for (const p of patterns) {
    if (p === origin) return true;
    if (p.includes("*")) {
      // Convert glob → regex. Anchored. Only `*` is a wildcard; everything
      // else is escaped so dots stay literal.
      const pattern: string =
        "^" +
        p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
        "$";
      if (new RegExp(pattern).test(origin)) return true;
    }
  }
  return false;
}

const corsOrigin = (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void => {
  if (originAllowed(origin)) cb(null, true);
  else cb(new Error(`Origin ${origin} not allowed by CORS`), false);
};

function main(): void {
  // Tiny HTTP listener so Render's health check + browsers hitting the
  // root URL get a friendly 200 instead of a confusing connect error.
  const httpServer = createServer((req, res) => {
    if (req.url === "/" || req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("syncle socket server ok\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });

  const io = new IOServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    {
      cors: { origin: corsOrigin, credentials: true },
      pingInterval: 15_000,
      pingTimeout: 10_000,
      maxHttpBufferSize: 5 * 1024 * 1024,
      // Long polling fallback path — keep the default `/socket.io` so the
      // client doesn't need any custom `path` config.
    },
  );

  wireSocketServer(io);

  httpServer
    .once("error", (err) => {
      console.error("[syncle:socket] http server error:", err);
      process.exit(1);
    })
    .listen(port, host, () => {
      const display = host === "0.0.0.0" ? "localhost" : host;
      const corsLabel = allowAny ? "*" : patterns.join(",");
      console.log(
        `[syncle:socket] listening on http://${display}:${port}  (cors=${corsLabel})`,
      );
    });

  const shutdown = (sig: string): void => {
    console.log(`[syncle:socket] received ${sig}, shutting down...`);
    io.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
