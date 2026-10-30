/** Dedicated no-delivery DEV proof; never load production env files. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { productFingerprint, validatedEnvironment, envDigest } from "./manager-proof-build.mjs";
const safeEnv = validatedEnvironment(process.env);
if (!safeEnv.SUPABASE_DB_SSL_CA_FILE || !path.isAbsolute(safeEnv.SUPABASE_DB_SSL_CA_FILE) || !lstatSync(safeEnv.SUPABASE_DB_SSL_CA_FILE).isFile()) throw new Error("Absolute verified CA required.");
if (!existsSync(".next/auth-proof-build.json") || !existsSync(".next/BUILD_ID")) throw new Error("Safe proof build required.");
const marker = JSON.parse(readFileSync(".next/auth-proof-build.json", "utf8"));
if (marker.fingerprint !== productFingerprint() || marker.envDigest !== envDigest() || marker.project !== "emstjswhotsnyksqhqyf" || marker.origin !== "http://localhost:3007" || marker.buildId !== readFileSync(".next/BUILD_ID", "utf8").trim()) throw new Error("Proof build no longer matches source.");
await new Promise((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(3007, "127.0.0.1", () => s.close(resolve)); });
const catalog = spawnSync("node_modules/.bin/tsx", ["tests/e2e/support/manager-catalog-preflight.ts"], { env: safeEnv, stdio: "ignore", timeout: 120000 });
if (catalog.status !== 0) throw new Error("Read-only catalog preflight failed.");
const dir = mkdtempSync(path.join(os.tmpdir(), "proplane-auth-proof-"));
if ((lstatSync(dir).mode & 0o777) !== 0o700) throw new Error("Private capture directory required.");
const env = { ...safeEnv, AUTH_PROOF_CAPTURE_DIR: dir, AUTH_PROOF_TWO_PHASE_RUNNER: "1", NEXT_PUBLIC_APP_URL: "http://localhost:3007", PLAYWRIGHT_BASE_URL: "http://localhost:3007", PLAYWRIGHT_SKIP_WEBSERVER: "1", RESEND_API_KEY: "re_dummy_auth_browser_no_delivery", RESEND_FROM: "Auth Proof <proof@example.invalid>", NODE_ENV: "production" };
const preload = path.resolve("tests/e2e/support/no-delivery-preload.mjs");
const server = spawn(process.execPath, ["--import", preload, "node_modules/next/dist/bin/next", "start", "-p", "3007", "-H", "127.0.0.1"], { env, stdio: "ignore" });
let serverExited = false;
const serverExit = new Promise((resolve) => server.once("exit", () => { serverExited = true; resolve(); }));
let browserOk = false;
let stage = "readiness";
let portClosed = false;
let cleanupExit = null;
try {
  for (let i = 0; i < 100; i++) {
    if (serverExited) throw new Error("Proof server exited before readiness.");
    try { const r = await fetch("http://127.0.0.1:3007/auth/sign-in", { redirect: "manual" }); if (r.status === 200) break; } catch { /* waiting */ }
    if (i === 99) throw new Error("Proof server did not become ready.");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  stage = "browser";
  const result = spawnSync("node_modules/.bin/playwright", ["test", "tests/e2e/manager-get-started-signed-in.spec.ts", "--project=chromium", "--grep", "signed-in manager can create a SECOND account", "--no-deps"], { env, encoding: "utf8", timeout: 150000 });
  browserOk = result.status === 0;
  const phases = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").filter((line) => /^\[synthetic-manager-e2e\] (phase=[a-z-]+ last_http_status=(?:[0-9]+|not-observed)|failed_phase=[a-z-]+ last_http_status=(?:[0-9]+|not-observed))$/.test(line));
  writeFileSync(path.join(dir, "phases.json"), JSON.stringify(phases), { mode: 0o600 });
} catch {
  browserOk = false;
} finally {
  if (!serverExited) server.kill("SIGTERM");
  try { await Promise.race([serverExit, new Promise((_, reject) => setTimeout(() => reject(new Error("Proof server did not exit; fixture retained.")), 10000))]); }
  catch { stage = "server_exit_failed"; writeFileSync(path.join(dir, "status.json"), JSON.stringify({ stage, serverExited, browserOk }), { mode: 0o600 }); throw new Error("Proof server did not exit; fixture retained."); }
}
try { await new Promise((resolve, reject) => { const s = createServer(); s.once("error", () => reject(new Error("Proof port remains occupied; fixture retained."))); s.listen(3007, "127.0.0.1", () => s.close(resolve)); }); portClosed = true; }
catch { stage = "port_occupied"; writeFileSync(path.join(dir, "status.json"), JSON.stringify({ stage, serverExited, browserOk }), { mode: 0o600 }); throw new Error("Proof port remains occupied; fixture retained."); }
stage = "cleanup";
const cleanup = spawnSync("node_modules/.bin/tsx", ["tests/e2e/support/manager-two-phase-cleanup.ts"], { env: { ...env, AUTH_PROOF_SERVER_EXIT_VERIFIED: "1" }, stdio: "ignore", timeout: 120000 });
cleanupExit = cleanup.status;
stage = cleanupExit === 0 ? "complete" : "cleanup_failed";
writeFileSync(path.join(dir, "status.json"), JSON.stringify({ stage, serverExited, portClosed, browserOk, cleanupExit }), { mode: 0o600 });
if (!browserOk || cleanup.status !== 0) throw new Error("Proof or cleanup failed; inspect the private manifest.");
