#!/usr/bin/env node
/**
 * Phase ①: turn the captain's message into a Lavish plan and open it for review.
 *
 * No Linear ticket is created — the plan IS the artifact. File a ticket only
 * when the captain explicitly asks for one (`npm run linear:ticket`).
 *
 * Usage:
 *   npm run workflow:plan -- --chat "Residents tab crashes on open"
 *   npm run workflow:plan -- --chat "…" --image /path/shot.png
 *   npm run workflow:plan -- --title "…" --summary "…"
 *   npm run workflow:plan -- --ticket PRP-170 --title "…"   # label only, no API call
 *
 * Does NOT build code. The captain says "approved — build" first.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeActiveSession } from "./lavish-session.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const out = { images: [], open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--chat") out.chat = next();
    else if (a === "--ticket" || a === "--id") out.id = next();
    else if (a === "--title") out.title = next();
    else if (a === "--summary") out.summary = next();
    else if (a === "--image") out.images.push(next());
    else if (a === "--no-open") out.open = false;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`PropLane workflow — plan first, no code until the captain approves

  npm run workflow:plan -- --chat "describe the work"
  npm run workflow:plan -- --title "…" --summary "…"

Options:
  --chat <text>       captain's own words (becomes title + summary)
  --title / --summary explicit plan metadata
  --image <path>      captain screenshot (repeatable)
  --ticket <id>       optional label only; no Linear ticket is filed
  --no-open           write the plan without opening Lavish

The scaffold is a shell. Fill it — especially the UI tab — before showing him:
docs/agents/lavish-plan-standard.md

Next: he annotates in Lavish → you poll, apply, re-open → "approved — build".`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.chat && !args.title) {
    console.error("error: pass --chat \"<his message>\" or --title \"…\"");
    printHelp();
    process.exit(1);
  }

  const title = args.title ?? args.chat.slice(0, 120);
  const summary = args.summary ?? args.chat ?? title;

  const lavishArgs = ["--title", title, "--summary", summary];
  if (args.id) lavishArgs.push("--id", args.id);
  for (const img of args.images) lavishArgs.push("--image", img);
  if (args.open) lavishArgs.push("--open");

  const r = spawnSync(process.execPath, ["scripts/lavish-plan.mjs", ...lavishArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  console.log(out);
  if (r.status !== 0) process.exit(r.status ?? 1);

  const planPath = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.endsWith("plan.html") && l.includes(".lavish"));
  if (!planPath || !existsSync(planPath)) {
    console.error("error: could not find plan.html path in lavish output");
    process.exit(1);
  }

  writeActiveSession({ planPath, ticket: args.id ?? null });

  console.log(`
✓ Paused at plan review
  Plan:   ${planPath}
  Listen: npm run lavish:listen
  Poll:   npm run lavish:poll

Agent: fill the scaffold, keep polling every turn, reply with --agent-reply.
       No product code until the captain says **approved — build**.`);
}

main();
