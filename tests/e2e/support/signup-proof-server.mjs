/** Guarded build/start for the full signup-proof suite; no external provider delivery. */
import { spawn } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import dotenv from "dotenv";
import { stopOwnedChild } from "./signup-proof-process.mjs";
import { preflightSignupCleanup } from "../../../scripts/signup-proof-cleanup-preflight.mjs";
import { encryptionKeyBytes } from "../../../scripts/package-local-qa-build.mjs";
import { verifyInstalledQaBuild } from "../../../scripts/install-local-qa-build.mjs";
encryptionKeyBytes(process.env.QA_ARTIFACT_ENCRYPTION_KEY);
const origin = process.env.NEXT_PUBLIC_APP_URL;
const dir = process.env.AUTH_PROOF_CAPTURE_DIR;
const runNonce = process.env.SIGNUP_PROOF_RUN_NONCE;
const runnerPid = Number(process.env.SIGNUP_PROOF_RUNNER_PID);
if (!Number.isSafeInteger(runnerPid) || runnerPid <= 1 || !runNonce || !/^[a-f0-9]{32}$/.test(runNonce) || process.versions.node.split(".")[0] !== "22" || process.env.SIGNUP_PROOF_ENABLED !== "1" || process.env.NEXT_PUBLIC_SUPABASE_URL !== "https://emstjswhotsnyksqhqyf.supabase.co" || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY || !origin || !["http://localhost:3000", "http://localhost:3007", "http://localhost:3008", "http://localhost:3010"].includes(origin) || process.env.PLAYWRIGHT_BASE_URL !== origin || !dir || !path.isAbsolute(dir)) throw new Error("Signup proof server configuration refused.");
const stat = lstatSync(dir), realDir = realpathSync(dir), repo = realpathSync(process.cwd());
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || readdirSync(dir).length || realDir === repo || realDir.startsWith(`${repo}${path.sep}`)) throw new Error("Signup proof server requires a fresh private capture directory.");
const env = { ...process.env, RESEND_API_KEY: "re_dummy_auth_browser_no_delivery", RESEND_FROM: "Auth Proof <proof@example.invalid>" };
const keys = new Set(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_MESSAGING_SERVICE_SID", "CLAW_MESSENGER_API_KEY", "CLAW_MESSENGER_HTTP_BASE", "CLAW_MESSENGER_WS_URL"]);
for (const name of readdirSync(process.cwd()).filter((name) => /^\.env(?:\.|$)/.test(name))) {
  if (name.startsWith(".env.production")) throw new Error("Production environment file refused.");
  for (const key of Object.keys(dotenv.parse(readFileSync(name)))) if (/^(TWILIO_|CLAW_)/.test(key)) keys.add(key);
}
for (const key of Object.keys(env)) if (/^(TWILIO_|CLAW_)/.test(key)) keys.add(key);
for (const key of keys) env[key] = "";
delete env.NODE_OPTIONS;
delete env.QA_ARTIFACT_ENCRYPTION_KEY;
delete env.QA_ARTIFACT_ENCRYPTION_KEY_FILE;
delete env.SIGNUP_PROOF_PREBUILT_RECEIPT;
delete env.SIGNUP_PROOF_OBSERVER_URL;
delete env.SUPABASE_ACCESS_TOKEN;
let child;
let stopping = false;
const terminate = () => { stopping = true; if (child) void stopOwnedChild(child).catch(() => { process.exitCode = 1; }); };
process.on("SIGTERM", terminate); process.on("SIGINT", terminate);
function run(args) { return new Promise((resolve, reject) => { child = spawn(process.execPath, args, { env, stdio: "inherit", detached: true }); child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); }); }
function assertOwnedPortClosed() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error("Signup proof port is still occupied.")));
    probe.listen(Number(new URL(origin).port), "127.0.0.1", () => probe.close(resolve));
  });
}
await assertOwnedPortClosed();
await preflightSignupCleanup();
try {
if (process.env.SIGNUP_PROOF_PREBUILT_RECEIPT) {
  if (origin !== 'http://localhost:3010' || process.env.PLAYWRIGHT_SKIP_WEBSERVER) throw new Error('Prebuilt signup origin refused.');
  await verifyInstalledQaBuild({ root: repo, receiptPath: process.env.SIGNUP_PROOF_PREBUILT_RECEIPT, encryptionKey: process.env.QA_ARTIFACT_ENCRYPTION_KEY });
} else {
const build = await run(["--max-old-space-size=6144", "node_modules/next/dist/bin/next", "build"]);
if (stopping || build.code !== 0) throw new Error("Signup proof server build failed.");
}
if (stopping) throw new Error('Signup proof server stopped before startup.');
child = spawn(process.execPath, ["--max-old-space-size=512", "--import", path.resolve("tests/e2e/support/no-delivery-preload.mjs"), "node_modules/next/dist/bin/next", "start", "-p", new URL(origin).port, "-H", "127.0.0.1"], { env, stdio: "inherit", detached: true });
let exited = false;
const exit = new Promise((resolve) => { child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); }); });
for (let attempt = 0; attempt < 100; attempt++) {
  if (exited) throw new Error("Signup proof server exited before readiness.");
  try {
    const response = await fetch(`${origin}/auth/sign-in`, { redirect: "manual" });
    if (response.status === 200 && !exited) {
      writeFileSync(path.join(dir, "server-ready.json"), JSON.stringify({ origin, pid: child.pid, wrapperPid: process.pid, runNonce, runnerPid }), { flag: "wx", mode: 0o600 });
      break;
    }
  } catch { /* waiting for the task-owned server */ }
  if (attempt === 99) { terminate(); throw new Error("Signup proof server did not become ready."); }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
const start = await exit;
if (start.code !== 0 && !start.signal) throw new Error("Signup proof server exited unexpectedly.");

} finally {
  if (child) await stopOwnedChild(child);
  await assertOwnedPortClosed();
  writeFileSync(path.join(dir, "server-stopped.json"), JSON.stringify({ origin, pid: child?.pid, wrapperPid: process.pid, runNonce, portClosed: true }), { flag: "wx", mode: 0o600 });
  // No late sender can recreate a token capture after all owned processes exited.
  for (const name of readdirSync(dir)) {
    if (name !== "server-ready.json" && !/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(dir, name), entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o600) throw new Error("Signup capture cleanup refused.");
    unlinkSync(file);
  }
}
