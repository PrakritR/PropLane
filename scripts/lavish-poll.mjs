#!/usr/bin/env node
/**
 * Poll Lavish for captain feedback on the active plan session.
 *
 * Agents MUST run this after opening any Lavish plan and on every turn while
 * `.lavish/active-session.json` exists — see `.cursor/rules/lavish-plan-gate.mdc`.
 *
 * Usage:
 *   npm run lavish:poll                    # drain queued feedback (agent turns)
 *   npm run lavish:poll -- --wait          # block until feedback (dedicated wait)
 *   npm run lavish:poll -- --plan path.html
 *   npm run lavish:poll -- --clear         # captain approved — drop active session
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { readActiveSession, clearActiveSession, REPO_ROOT, LAVISH_DIR } from "./lavish-session.mjs";

const NOTIFY_FILE = resolve(LAVISH_DIR, "listener.notify");

function parseArgs(argv) {
  const out = { wait: false, clear: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--wait") out.wait = true;
    else if (a === "--clear") out.clear = true;
    else if (a === "--plan") out.plan = resolve(REPO_ROOT, next());
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`lavish:poll — fetch Lavish captain feedback (mandatory for agents)

  npm run lavish:poll              Short poll; prints queued feedback if any
  npm run lavish:poll -- --wait    Block until captain sends feedback
  npm run lavish:poll -- --plan .lavish/plans/foo/plan.html
  npm run lavish:poll -- --clear   Clear active session after approved — build

Agents: run \`npm run lavish:poll\` as the FIRST command when active-session.json exists.
Never end a turn after opening Lavish without polling at least once.`);
}

function runPoll(planPath, { wait }) {
  const args = ["-y", "lavish-axi", "poll", planPath];
  if (!wait) args.push("--timeout-ms", "12000");
  const r = spawnSync("npx", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { code: r.status ?? 1, out };
}

function hasFeedback(out) {
  if (!out) return false;
  if (/status:\s*waiting/i.test(out) && !/prompt:/i.test(out) && !/feedback:/i.test(out)) return false;
  if (/No user feedback arrived/i.test(out)) return false;
  return /prompt:|feedback:|tag:|approved|layout-warnings|whiteboard|artifact_failures/i.test(out);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.clear) {
    clearActiveSession();
    console.log("Cleared .lavish/active-session.json");
    return;
  }

  const session = readActiveSession();
  const planPath = args.plan ?? session?.planPath;
  if (!planPath || !existsSync(planPath)) {
    console.error("error: no active Lavish session. Open a plan first:");
    console.error("  npm run workflow:plan -- --chat \"…\"");
    console.error("  npx -y lavish-axi .lavish/plans/…/plan.html");
    process.exit(1);
  }

  if (session?.ticket) {
    console.log(`Active session: ${session.ticket} → ${planPath}`);
  } else {
    console.log(`Polling: ${planPath}`);
  }

  // Background listener may have captured feedback while agent was idle.
  if (existsSync(NOTIFY_FILE)) {
    const pending = readFileSync(NOTIFY_FILE, "utf8");
    if (hasFeedback(pending)) {
      console.log(pending);
      console.log("\n✓ Lavish feedback (from background listener) — apply before replying.");
      try {
        unlinkSync(NOTIFY_FILE);
      } catch {
        /* ignore */
      }
      process.exit(0);
    }
  }

  const { code, out } = runPoll(planPath, { wait: args.wait });
  if (out) console.log(out);

  if (hasFeedback(out)) {
    console.log("\n✓ Lavish feedback received — apply annotations before replying to captain.");
    process.exit(0);
  }

  if (args.wait) {
    process.exit(code);
  }

  console.log("\n(no queued feedback — run again after captain annotates, or use --wait)");
  process.exit(0);
}

main();
