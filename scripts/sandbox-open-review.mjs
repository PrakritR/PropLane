#!/usr/bin/env node
/**
 * Open the captain's browser on this sandbox to the route under review.
 *
 * Every agent should run this after a user-facing fix so the captain can test
 * instantly — see docs/agents/sandbox-open-review.md.
 *
 * Usage:
 *   npm run sandbox:open -- /portal/tasks
 *   npm run sandbox:open -- --print /portal/tasks
 *   npm run sandbox:open -- --port 3011 /portal/tasks
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const raw = process.argv.slice(2);
let printOnly = false;
let portOverride = "";
let route = "/";
for (let i = 0; i < raw.length; i++) {
  const arg = raw[i];
  if (arg === "--help" || arg === "-h") {
    console.log(`usage: npm run sandbox:open -- [--print] [--port <n>] </route>`);
    process.exit(0);
  }
  if (arg === "--print" || arg === "--no-browser") {
    printOnly = true;
    continue;
  }
  if (arg === "--open-browser") {
    printOnly = false;
    continue;
  }
  if (arg === "--port") {
    const next = raw[++i];
    if (!next || !/^\d{2,5}$/.test(next)) {
      console.error("--port requires a numeric port");
      process.exit(1);
    }
    portOverride = next;
    continue;
  }
  if (arg.startsWith("/")) {
    if (route !== "/") {
      console.error("Only one route path is allowed");
      process.exit(1);
    }
    route = arg.trim();
    continue;
  }
  console.error(`Unknown argument: ${arg}`);
  process.exit(1);
}

function readPortFromEnvLocal() {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return "";
  const text = readFileSync(envPath, "utf8");
  const m = text.match(/^NEXT_PUBLIC_APP_URL=http:\/\/localhost:(\d+)/m);
  return m?.[1] ?? "";
}

function readPortFromAgentRule() {
  const rulePath = join(process.cwd(), ".cursor/rules/local-agent-branch.mdc");
  if (!existsSync(rulePath)) return "";
  const text = readFileSync(rulePath, "utf8");
  const m = text.match(/localhost:(\d{4})/);
  return m?.[1] ?? "";
}

const port =
  portOverride ||
  process.env.PROPPLANE_SANDBOX_PORT?.trim() ||
  readPortFromEnvLocal() ||
  readPortFromAgentRule() ||
  "3010";

const url = `http://localhost:${port}${route}`;

try {
  writeFileSync(join(process.cwd(), ".proplane-review-path"), `${route}\n`, "utf8");
} catch {
  // optional — promote can still pass --path explicitly
}

function serverUp() {
  const res = spawnSync("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `http://localhost:${port}/`], {
    encoding: "utf8",
    timeout: 5000,
  });
  const code = (res.stdout || "").trim();
  return res.status === 0 && /^\d{3}$/.test(code) && code !== "000";
}

function openBrowser(target) {
  const fmOpen = join(process.env.HOME || "", "firstmate/bin/fm-open-url.sh");
  if (existsSync(fmOpen)) {
    const r = spawnSync(fmOpen, [target], { stdio: "inherit" });
    return r.status === 0;
  }
  if (process.platform === "darwin") {
    spawnSync("open", [target], { stdio: "inherit" });
    return true;
  }
  if (process.platform === "linux") {
    spawnSync("xdg-open", [target], { stdio: "inherit" });
    return true;
  }
  return false;
}

console.log(`Review URL: ${url}`);

if (!serverUp()) {
  console.warn(
    `\n  ⚠  No dev server detected on port ${port}.\n` +
      `     Start one:  npm run dev -- -p ${port}\n` +
      `     Or from firstmate:  bin/fm-proplane-open-localhost.sh --open-browser\n`,
  );
}

if (printOnly) {
  process.exit(0);
}

if (!openBrowser(url)) {
  console.error("Could not open a browser — paste the Review URL above.");
  process.exit(1);
}
