#!/usr/bin/env node
/**
 * Long-poll Lavish for captain feedback on a plan artifact.
 *
 * Usage:
 *   npm run lavish:poll -- --plan .lavish/plans/PRP-335-…/plan.html
 *   npm run lavish:poll                    # newest plan under .lavish/plans/
 *
 * Agents: run this after opening or editing any Lavish plan, and again at the
 * start of the next turn if the captain may have annotated while you were away.
 * Lavish shows "agent is not listening" when nothing is polling.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") out.plan = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function findLatestPlan() {
  const plansRoot = join(REPO_ROOT, ".lavish", "plans");
  if (!existsSync(plansRoot)) return null;
  let best = null;
  let bestMtime = 0;
  for (const dir of readdirSync(plansRoot)) {
    const html = join(plansRoot, dir, "plan.html");
    if (!existsSync(html)) continue;
    const mtime = statSync(html).mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = html;
    }
  }
  return best;
}

function printHelp() {
  console.log(`lavish:poll — wait for captain feedback on a Lavish plan

  npm run lavish:poll -- --plan .lavish/plans/PRP-###-slug/plan.html
  npm run lavish:poll

Agents must poll after every Lavish open or plan edit. If Lavish says the agent
is not listening, run this command again — queued feedback is not lost.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const planPath = args.plan
    ? join(REPO_ROOT, args.plan.replace(/^\//, ""))
    : findLatestPlan();

  if (!planPath || !existsSync(planPath)) {
    console.error("error: plan.html not found — pass --plan <path>");
    printHelp();
    process.exit(1);
  }

  console.log(`[lavish:poll] Listening on ${planPath}`);
  execFileSync("npx", ["-y", "lavish-axi", "poll", planPath], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

main();
