/** Dedicated, reviewed split-B DEV proof using the retained email-verified synthetic manager. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
if ((lstatSync(statusFile).mode & 0o777) !== 0o600) throw new Error("Private Phase A status required.");
const phaseA = JSON.parse(readFileSync(statusFile, "utf8"));
const input = JSON.parse(readFileSync(inputFile, "utf8"));
const managerManifestFile = path.join(dir, `manager-${createHash("sha256").update(String(input.expectedEmail ?? "").toLowerCase()).digest("hex")}.manifest.json`);
if (!existsSync(managerManifestFile) || (lstatSync(managerManifestFile).mode & 0o777) !== 0o600) throw new Error("Private synthetic manager manifest required.");
const managerManifest = JSON.parse(readFileSync(managerManifestFile, "utf8"));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phaseFile = path.join(dir, "phases.json"), priorBPhases = path.join(dir, "split-b-phases.json"), priorBManifest = path.join(dir, "split-b-manifest.json");
const retryingKnownPrebrowserFailure = phaseA.stage === "phase_b_browser_failed_draft_checked" && phaseA.browserOk === false &&
  phaseA.serverExited === true && phaseA.portClosed === true && phaseA.draftCleanupExit === 0 &&
  phaseA.accountRetained === true && phaseA.sessionRetained === true && existsSync(phaseFile) &&
  !existsSync(priorBPhases) && !existsSync(priorBManifest);
const aEvidence = existsSync(phaseFile) && (lstatSync(phaseFile).mode & 0o777) === 0o600 ? readFileSync(phaseFile, "utf8") : "";
const knownPhoneGateEvidence = aEvidence.includes("phase=await-account-ready last_http_status=200") &&
  aEvidence.includes("phase=phone-gate-observed last_http_status=200");
const validAStatus = (phaseA.stage === "phase_a_complete" && phaseA.browserOk === true && phaseA.serverExited === true && phaseA.portClosed === true) || retryingKnownPrebrowserFailure;
if (!validAStatus || (retryingKnownPrebrowserFailure && !knownPhoneGateEvidence) ||
  input.version !== 1 || !uuid.test(input.managerId) || !uuid.test(input.workspaceId) ||
  !/^get-started-e2e-[0-9]+@example\.invalid$/.test(input.expectedEmail) || input.phoneMarker !== "synthetic_test_only_no_sms" ||
  managerManifest.state !== "identified" || managerManifest.authId !== input.managerId || managerManifest.email?.toLowerCase() !== input.expectedEmail.toLowerCase() ||
  path.resolve(input.storageStateFile) !== path.join(dir, "manager-storage-state.json") || (lstatSync(inputFile).mode & 0o777) !== 0o600 || (lstatSync(input.storageStateFile).mode & 0o777) !== 0o600) {
  throw new Error("Phase A private identity does not pass the exact synthetic contract.");
}
await new Promise((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(3007, "127.0.0.1", () => s.close(resolve)); });
const catalog = spawnSync("node_modules/.bin/tsx", ["tests/e2e/support/manager-catalog-preflight.ts"], { env: safeEnv, stdio: "ignore", timeout: 120000 });
if (catalog.status !== 0) throw new Error("Read-only catalog preflight failed.");
const serverCaptureDir = path.join(dir, "split-b-server-capture");
if (existsSync(serverCaptureDir)) throw new Error("Fresh private split-B capture directory already exists.");
mkdirSync(serverCaptureDir, { mode: 0o700 }); chmodSync(serverCaptureDir, 0o700);
const serverLog = path.join(dir, "split-b-server.log"), browserLog = path.join(dir, "split-b-browser.log");
if (existsSync(serverLog) || existsSync(browserLog) || existsSync(path.join(dir, "split-b-status.json"))) throw new Error("Fresh private split-B evidence paths required.");
const env = { ...safeEnv, AUTH_PROOF_CAPTURE_DIR: serverCaptureDir, SPLIT_B_DEDICATED_RUNNER: "1", SPLIT_B_PRIVATE_DIR: dir,
  SPLIT_B_VERIFIED_PREBROWSER_RETRY: retryingKnownPrebrowserFailure ? "1" : "",
  SPLIT_B_MANAGER_ID: input.managerId, SPLIT_B_WORKSPACE_ID: input.workspaceId, SPLIT_B_EXPECTED_EMAIL: input.expectedEmail,
  SPLIT_B_STORAGE_STATE: input.storageStateFile, NEXT_PUBLIC_APP_URL: "http://localhost:3007", PLAYWRIGHT_BASE_URL: "http://localhost:3007",
  PLAYWRIGHT_SKIP_WEBSERVER: "1", NODE_ENV: "production" };
const preload = path.resolve("tests/e2e/support/no-delivery-preload.mjs");
const serverFd = openSync(serverLog, "wx", 0o600);
const server = spawn(process.execPath, ["--import", preload, "node_modules/next/dist/bin/next", "start", "-p", "3007", "-H", "127.0.0.1"], { env, stdio: ["ignore", serverFd, serverFd] });
closeSync(serverFd);
let serverExited = false;
const serverExit = new Promise((resolve) => server.once("exit", () => { serverExited = true; resolve(); }));
let browserOk = false, stage = "readiness", portClosed = false, errorClass = null, errorCode = null, errorStage = null;
const phaseMarker = path.join(dir, "split-b-phases.json");
writeFileSync(phaseMarker, JSON.stringify({ stage: "server_starting", serverExited: false }), { mode: 0o600 });
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
  writeFileSync(browserLog, `${result.stdout ?? ""}\n${result.stderr ?? ""}`, { mode: 0o600, flag: "wx" });
  if (result.error) {
    errorStage = stage;
    errorClass = result.error.name === "Error" ? "Error" : "ProcessError";
    errorCode = typeof result.error.code === "string" && /^[A-Z0-9_]{1,24}$/.test(result.error.code) ? result.error.code : null;
  }
  const safeLines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").filter((line) => /^\[split-b-e2e\] (phase=[a-z-]+ status=(?:[0-9]+|not-observed)|failed_phase=[a-z-]+ status=(?:[0-9]+|not-observed))$/.test(line));
  writeFileSync(phaseMarker, JSON.stringify({ stage: "browser_finished", lines: safeLines, exitStatus: result.status }), { mode: 0o600 });
} catch (error) { browserOk = false; errorStage = stage; errorClass = error?.name === "Error" ? "Error" : "ProcessError"; errorCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,24}$/.test(error.code) ? error.code : null; }
finally {
  if (!serverExited) server.kill("SIGTERM");
  try { await Promise.race([serverExit, new Promise((_, reject) => setTimeout(() => reject(new Error("Proof server did not exit; retain draft manifest.")), 10000))]); }
  catch { stage = "server_exit_failed"; writeFileSync(path.join(dir, "split-b-status.json"), JSON.stringify({ stage, serverExited, browserOk, accountRetained: true, errorStage, errorClass, errorCode }), { mode: 0o600 }); throw new Error("Proof server did not exit; retain all synthetic state."); }
}
try { await new Promise((resolve, reject) => { const s = createServer(); s.once("error", () => reject(new Error("Proof port remains occupied; retain draft manifest."))); s.listen(3007, "127.0.0.1", () => s.close(resolve)); }); portClosed = true; }
catch { stage = "port_occupied"; writeFileSync(path.join(dir, "split-b-status.json"), JSON.stringify({ stage, serverExited, browserOk, accountRetained: true, errorStage, errorClass, errorCode }), { mode: 0o600 }); throw new Error("Proof port remains occupied; retain all synthetic state."); }
stage = "draft_cleanup";
const cleanup = spawnSync("node_modules/.bin/tsx", ["tests/e2e/support/split-b-cleanup.ts"], { env: { ...env, SPLIT_B_SERVER_EXIT_VERIFIED: "1" }, stdio: "ignore", timeout: 120000 });
stage = cleanup.status === 0 ? (browserOk ? "phase_b_draft_cleaned" : "phase_b_browser_failed_draft_checked") : "phase_b_draft_cleanup_failed";
writeFileSync(path.join(dir, "split-b-status.json"), JSON.stringify({ stage, serverExited, portClosed, browserOk, draftCleanupExit: cleanup.status, accountRetained: true, sessionRetained: true, errorStage, errorClass, errorCode }), { mode: 0o600 });
if (!browserOk || cleanup.status !== 0) throw new Error("Split-B proof or exact draft cleanup failed; retain fixture for review.");
