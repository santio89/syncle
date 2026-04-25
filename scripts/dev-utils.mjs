/**
 * Tiny helpers shared between scripts/dev.mjs (legacy `next dev` launcher)
 * and server.mjs (custom Next.js + Socket.IO bootstrap).
 *
 * Kept dependency-free so it imports cleanly into both ESM contexts.
 */

import net from "node:net";

/**
 * Hosts to probe. Next binds dual-stack on Windows (::), so we have to make
 * sure the port is free on BOTH IPv4 and IPv6 - otherwise `EADDRINUSE`
 * surprises us when we hand the port to Next.
 */
const PROBE_HOSTS = ["0.0.0.0", "::"];

/** Resolve to true if the port can be bound on `host`, false otherwise. */
function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen({ port, host, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

export async function isPortFree(port) {
  for (const host of PROBE_HOSTS) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await canBind(port, host);
    if (!ok) return false;
  }
  return true;
}

/** First free port starting at `start`, scanning up to `maxTries` ports. */
export async function findFreePort(start = 3000, maxTries = 50) {
  for (let i = 0; i < maxTries; i++) {
    const port = start + i;
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(port);
    if (free) return port;
    if (i === 0) {
      console.log(`[port] ${port} in use, scanning...`);
    }
  }
  return null;
}
