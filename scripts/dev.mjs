#!/usr/bin/env node
/**
 * Next.js launcher that finds the first free port starting at 3000
 * (up to MAX_TRIES attempts) and then execs the requested next subcommand
 * on that port.
 *
 * Usage:
 *   node scripts/dev.mjs              # runs `next dev` on first free port
 *   node scripts/dev.mjs start        # runs `next start` on first free port
 *   node scripts/dev.mjs dev --turbo  # extra args forwarded to next
 *
 * Why: when iterating quickly, leftover processes hold port 3000 and
 * `next dev|start` crashes with EADDRINUSE. This wrapper sidesteps that.
 */

import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const START_PORT = Number(process.env.PORT) || 3000;
const MAX_TRIES = 50;
// Hosts to probe. Next binds dual-stack on Windows (::), so we have to make
// sure the port is free on BOTH IPv4 and IPv6 — checking only one was the
// bug that let our wrapper think 3000 was "free" while Next still failed
// with EADDRINUSE on :::3000.
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
      // exclusive:true → matches Next's strict bind, no SO_REUSEADDR sharing.
      server.listen({ port, host, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

async function isPortFree(port) {
  for (const host of PROBE_HOSTS) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await canBind(port, host);
    if (!ok) return false;
  }
  return true;
}

async function findFreePort() {
  for (let i = 0; i < MAX_TRIES; i++) {
    const port = START_PORT + i;
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(port);
    if (free) return port;
    if (i === 0) {
      console.log(`[next] port ${port} in use, scanning...`);
    }
  }
  return null;
}

/** Run `next build` and resolve when it finishes. */
function runBuild() {
  return new Promise((resolve, reject) => {
    console.log("[next] no production build found, running `next build`...");
    const child = spawn("npx", ["next", "build"], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`next build exited with code ${code}`));
    });
  });
}

async function main() {
  // First positional arg is the next subcommand; default to "dev".
  const argv = process.argv.slice(2);
  const known = new Set(["dev", "start"]);
  let sub = "dev";
  if (argv[0] && known.has(argv[0])) {
    sub = argv.shift();
  }
  const extra = argv;

  // Production server needs `.next` to exist. Auto-build if it doesn't.
  if (sub === "start") {
    const buildIdPath = path.join(process.cwd(), ".next", "BUILD_ID");
    if (!existsSync(buildIdPath)) {
      try {
        await runBuild();
      } catch (err) {
        console.error("[next] build failed:", err.message);
        process.exit(1);
      }
    }
  }

  const port = await findFreePort();
  if (port == null) {
    console.error(
      `[next] could not find a free port in ${START_PORT}..${
        START_PORT + MAX_TRIES - 1
      }`,
    );
    process.exit(1);
  }
  if (port !== START_PORT) {
    console.log(`[next] port ${START_PORT} taken, using ${port} instead`);
  } else {
    console.log(`[next] using port ${port}`);
  }

  const args = ["next", sub, "-p", String(port), ...extra];

  // Use npx so we don't depend on a local PATH entry. Shell:true on Windows
  // so `npx.cmd` resolves correctly.
  const child = spawn("npx", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, PORT: String(port) },
  });

  const forward = (sig) => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error("[next] launcher failed:", err);
  process.exit(1);
});
