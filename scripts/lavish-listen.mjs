#!/usr/bin/env node
/**
 * Keep Lavish "listening" — long-poll in background so the UI stops showing
 * "Your agent is not listening". Started automatically when a plan opens.
 *
 *   npm run lavish:listen          # start/restart background listener
 *   npm run lavish:listen -- --stop
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import {
  readActiveSession,
  ensureLavishDir,
  LAVISH_DIR,
  REPO_ROOT,
} from "./lavish-session.mjs";

const PID_FILE = resolve(LAVISH_DIR, "listener.pid");
const LOG_FILE = resolve(LAVISH_DIR, "listener.log");
const NOTIFY_FILE = resolve(LAVISH_DIR, "listener.notify");

function parseArgs(argv) {
  const out = { stop: false };
  for (const a of argv) {
    if (a === "--stop") out.stop = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopListener() {
  if (!existsSync(PID_FILE)) return;
  const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  if (pid && isAlive(pid)) {
    process.kill(pid, "SIGTERM");
  }
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

function startListener(planPath) {
  stopListener();
  ensureLavishDir();
  writeFileSync(LOG_FILE, `[${new Date().toISOString()}] listener starting → ${planPath}\n`, "utf8");

  const child = spawn("npx", ["-y", "lavish-axi", "poll", planPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const logFd = openSync(LOG_FILE, "a");
  child.stdout.on("data", (chunk) => {
    writeFileSync(LOG_FILE, chunk, { flag: "a" });
    if (/prompts\[|status:\s*feedback/i.test(String(chunk))) {
      writeFileSync(NOTIFY_FILE, `${Date.now()}\n${chunk}`, "utf8");
    }
  });
  child.stderr.on("data", (chunk) => writeFileSync(LOG_FILE, chunk, { flag: "a" }));
  child.on("exit", (code) => {
    writeFileSync(LOG_FILE, `\n[${new Date().toISOString()}] listener exited ${code}\n`, { flag: "a" });
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
  });
  child.unref();
  closeSync(logFd);

  writeFileSync(PID_FILE, String(child.pid), "utf8");
  console.log(`Lavish listener running (pid ${child.pid})`);
  console.log(`  plan: ${planPath}`);
  console.log(`  log:  ${LOG_FILE}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`lavish:listen — background long-poll so Lavish shows "agent listening"

  npm run lavish:listen        Start listener for active session
  npm run lavish:listen -- --stop`);
    return;
  }

  if (args.stop) {
    stopListener();
    console.log("Stopped Lavish listener");
    return;
  }

  const session = readActiveSession();
  if (!session?.planPath || !existsSync(session.planPath)) {
    console.error("error: no active Lavish session (.lavish/active-session.json)");
    process.exit(1);
  }

  if (existsSync(PID_FILE)) {
    const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (pid && isAlive(pid)) {
      console.log(`Lavish listener already running (pid ${pid})`);
      return;
    }
  }

  startListener(resolve(REPO_ROOT, session.planPath));
}

main();
