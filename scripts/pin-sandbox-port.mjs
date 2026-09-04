#!/usr/bin/env node
/**
 * Pin NEXT_PUBLIC_APP_URL to the agent sandbox port in .env.local.
 *
 * Each worktree runs on its own port (cursor-1 → 3010, cursor-2 → 3011, …).
 * Shared .env from seed:env often leaves APP_URL at :3000, which breaks
 * multi-agent isolation when server code builds absolute localhost URLs.
 *
 * Usage:
 *   node scripts/pin-sandbox-port.mjs 3011
 *   npm run sandbox:pin -- 3011
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const portArg = process.argv[2]?.trim();
const port = portArg || process.env.PROPPLANE_SANDBOX_PORT?.trim();
if (!port || !/^\d{2,5}$/.test(port)) {
  console.error("usage: pin-sandbox-port.mjs <port>  (e.g. 3011 for cursor-2)");
  process.exit(1);
}

const origin = `http://localhost:${port}`;
const envPath = join(process.cwd(), ".env.local");
const key = "NEXT_PUBLIC_APP_URL";

let text = "";
if (existsSync(envPath)) {
  text = readFileSync(envPath, "utf8");
} else {
  console.warn(`.env.local missing — creating with ${key}=${origin}`);
}

const lineRe = new RegExp(`^${key}=.*$`, "m");
if (lineRe.test(text)) {
  text = text.replace(lineRe, `${key}=${origin}`);
} else {
  text = text.trimEnd() + (text.endsWith("\n") || text.length === 0 ? "" : "\n") + `${key}=${origin}\n`;
}

writeFileSync(envPath, text, "utf8");
console.log(`Pinned ${key}=${origin} in .env.local`);

// `NEXT_PUBLIC_*` is inlined into the CLIENT BUNDLE at build time, so a dev
// server that was already running keeps serving the old origin — auth redirects
// carry on landing on whatever port it started with, and the pin looks like it
// did nothing. Saying "restart" in passing was not enough; if a server is
// answering on this port right now, that is precisely the footgun, so say so
// loudly (PRP-217).
const alreadyServing = await fetch(`${origin}/`, { method: "HEAD" })
  .then(() => true)
  .catch(() => false);

if (alreadyServing) {
  console.warn(
    `\n  ⚠  A dev server is ALREADY RUNNING on ${port}.\n` +
      `     It is still serving the old ${key}, because NEXT_PUBLIC_* values are\n` +
      `     baked into the client bundle at build time. Auth redirects will keep\n` +
      `     landing on the old port until you restart it:\n\n` +
      `       npm run dev -- -p ${port}\n`,
  );
} else {
  console.log(`Start the dev server on this port:  npm run dev -- -p ${port}`);
}
