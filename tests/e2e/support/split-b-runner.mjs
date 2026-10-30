/** Dedicated, reviewed split-B DEV proof using the retained email-verified synthetic manager. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { productFingerprint, validatedEnvironment, envDigest } from "./manager-proof-build.mjs";
const safeEnv = validatedEnvironment(process.env);
if (!safeEnv.SUPABASE_DB_SSL_CA_FILE || !path.isAbsolute(safeEnv.SUPABASE_DB_SSL_CA_FILE) || !lstatSync(safeEnv.SUPABASE_DB_SSL_CA_FILE).isFile()) throw new Error("Absolute verified CA required.");
if (!existsSync(".next/auth-proof-build.json") || !existsSync(".next/BUILD_ID")) throw new Error("Safe proof build required.");
const marker = JSON.parse(readFileSync(".next/auth-proof-build.json", "utf8"));
if (marker.fingerprint !== productFingerprint() || marker.envDigest !== envDigest() || marker.project !== "emstjswhotsnyksqhqyf" || marker.origin !== "http://localhost:3007" || marker.buildId !== readFileSync(".next/BUILD_ID", "utf8").trim()) throw new Error("Proof build no longer matches source.");
const dir = path.resolve(process.env.AUTH_PROOF_CAPTURE_DIR ?? "");
if (!process.env.AUTH_PROOF_CAPTURE_DIR || (lstatSync(dir).mode & 0o777) !== 0o700) throw new Error("Private retained Phase A directory required.");
const statusFile = path.join(dir, "status.json"), inputFile = path.join(dir, "split-b-input.json");
if (!existsSync(statusFile) || !existsSync(inputFile)) throw new Error("Completed Phase A fixture required.");
const phaseA = JSON.parse(readFileSync(statusFile, "utf8"));
const input = JSON.parse(readFileSync(inputFile, "utf8"));
const managerManifestFile = path.join(dir, `manager-${createHash("sha256").update(String(input.expectedEmail ?? "").toLowerCase()).digest("hex")}.manifest.json`);
if (!existsSync(managerManifestFile) || (lstatSync(managerManifestFile).mode & 0o777) !== 0o600) throw new Error("Private synthetic manager manifest required.");
const managerManifest = JSON.parse(readFileSync(managerManifestFile, "utf8"));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (phaseA.stage !== "phase_a_complete" || phaseA.browserOk !== true || phaseA.serverExited !== true || phaseA.portClosed !== true ||
  input.version !== 1 || !uuid.test(input.managerId) || !uuid.test(input.workspaceId) ||
  !/^get-started-e2e-[0-9]+@example\.invalid$/.test(input.expectedEmail) || input.phoneMarker !== "synthetic_test_only_no_sms" ||
  managerManifest.state !== "identified" || managerManifest.authId !== input.managerId || managerManifest.email?.toLowerCase() !== input.expectedEmail.toLowerCase() ||
  path.resolve(input.storageStateFile) !== path.join(dir, "manager-storage-state.json") || (lstatSync(inputFile).mode & 0o777) !== 0o600 || (lstatSync(input.storageStateFile).mode & 0o777) !== 0o600) {
  throw new Error("Phase A private identity does not pass the exact synthetic contract.");
}
await new Promise((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(3007, "127.0.0.1", () => s.close(resolve)); });
const catalog = spawnSync("node_modules/.bin/tsx", ["tests/e2e/support/manager-catalog-preflight.ts"], { env: safeEnv, stdio: "ignore", timeout: 120000 });
if (catalog.status !== 0) throw new Error("Read-only catalog preflight failed.");
const env = { ...safeEnv, AUTH_PROOF_CAPTURE_DIR: dir, SPLIT_B_DEDICATED_RUNNER: "1", SPLIT_B_PRIVATE_DIR: dir,
  SPLIT_B_MANAGER_ID: input.managerId, SPLIT_B_WORKSPACE_ID: input.workspaceId, SPLIT_B_EXPECTED_EMAIL: input.expectedEmail,
  SPLIT_B_STORAGE_STATE: input.storageStateFile, NEXT_PUBLIC_APP_URL: "http://localhost:3007", PLAYWRIGHT_BASE_URL: "http://localhost:3007",
  PLAYWRIGHT_SKIP_WEBSERVER: "1", NODE_ENV: "production" };
const preload = path.resolve("tests/e2e/support/no-delivery-preload.mjs");
const server = spawn(process.execPath, ["--import", preload, "node_modules/next/dist/bin/next", "start", "-p", "3007", "-H", "127.0.0.1"], { env, stdio: "ignore" });
let serverExited = false;
const serverExit = new Promise((resolve) => server.once("exit", () => { serverExited = true; resolve(); }));
let browserOk = false, stage = "readiness", portClosed = false;
try {
  for (let i = 0; i < 100; i++) {
    if (serverExited) throw new Error("Proof server exited before readiness.");
    try { const response = await fetch("http://127.0.0.1:3007/auth/sign-in", { redirect: "manual" }); if (response.status === 200) break; } catch { /* waiting */ }
    if (i === 99) throw new Error("Proof server did not become ready.");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  stage = "browser";
  const result = spawnSync("node_modules/.bin/playwright", ["test", "tests/e2e/split-b-private-draft.spec.ts", "--project=chromium", "--no-deps"], { env, encoding: "utf8", timeout: 150000 });
  browserOk = result.status === 0;
  const safeLines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").filter((line) => /^\[split-b-e2e\] (phase=[a-z-]+ status=(?:[0-9]+|not-observed)|failed_phase=[a-z-]+ status=(?:[0-9]+|not-observed))$/.test(line));
  writeFileSync(path.join(dir, "split-b-phases.json"), JSON.stringify(safeLines), { mode: 0o600 });
} catch { browserOk = false; }
finally {
  if (!serverExited) server.kill("SIGTERM");
  try { await Promise.race([serverExit, new Promise((_, reject) => setTimeout(() => reject(new Error("Proof server did not exit; retain draft manifest.")), 10000))]); }
  catch { stage = "server_exit_failed"; writeFileSync(statusFile, JSON.stringify({ stage, serverExited, browserOk, accountRetained: true }), { mode: 0o600 }); throw new Error("Proof server did not exit; retain all synthetic state."); }
}
try { await new Promise((resolve, reject) => { const s = createServer(); s.once("error", () => reject(new Error("Proof port remains occupied; retain draft manifest."))); s.listen(3007, "127.0.0.1", () => s.close(resolve)); }); portClosed = true; }
catch { stage = "port_occupied"; writeFileSync(statusFile, JSON.stringify({ stage, serverExited, browserOk, accountRetained: true }), { mode: 0o600 }); throw new Error("Proof port remains occupied; retain all synthetic state."); }
stage = "draft_cleanup";
const cleanup = spawnSync("node_modules/.bin/tsx", ["tests/e2e/support/split-b-cleanup.ts"], { env: { ...env, SPLIT_B_SERVER_EXIT_VERIFIED: "1" }, stdio: "ignore", timeout: 120000 });
stage = cleanup.status === 0 ? (browserOk ? "phase_b_draft_cleaned" : "phase_b_browser_failed_draft_checked") : "phase_b_draft_cleanup_failed";
writeFileSync(statusFile, JSON.stringify({ stage, serverExited, portClosed, browserOk, draftCleanupExit: cleanup.status, accountRetained: true, sessionRetained: true }), { mode: 0o600 });
if (!browserOk || cleanup.status !== 0) throw new Error("Split-B proof or exact draft cleanup failed; retain fixture for review.");
