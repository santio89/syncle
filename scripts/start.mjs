/**
 * Cross-platform production starter for the custom Next.js + Socket.IO
 * server. Sets NODE_ENV=production (without depending on shell syntax) and
 * runs `tsx server.ts`. This is what Render's Start Command invokes.
 *
 * If `.next/BUILD_ID` is missing we trigger `next build` first; that way
 * `npm start` works in a clean checkout without a separate build step,
 * which is convenient for local prod smoke tests.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const isWin = process.platform === "win32";

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: isWin,
      env,
    });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function main() {
  const buildId = path.join(process.cwd(), ".next", "BUILD_ID");
  if (!existsSync(buildId)) {
    console.log("[syncle] no production build found, running `next build`...");
    await run("npx", ["next", "build"], process.env);
  }
  const env = { ...process.env, NODE_ENV: "production" };
  await run("npx", ["tsx", "server.ts"], env);
}

main().catch((err) => {
  console.error("[syncle] start failed:", err.message ?? err);
  process.exit(1);
});
