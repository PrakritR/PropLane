/** Own the whole proof process lifecycle, including failed/interrupted local runs. */
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, realpathSync, mkdirSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { encryptionKeyBytes } from "./package-local-qa-build.mjs";
import { preflightSignupCleanup } from "./signup-proof-cleanup-preflight.mjs";
import { stopOwnedChild, finishOwnedProof } from "../tests/e2e/support/signup-proof-process.mjs";

if (process.versions.node.split(".")[0] !== "22" || process.env.SIGNUP_PROOF_ENABLED !== "1") throw new Error("Guarded signup runner configuration refused.");
encryptionKeyBytes(process.env.QA_ARTIFACT_ENCRYPTION_KEY);
await preflightSignupCleanup();
const dir = process.env.AUTH_PROOF_CAPTURE_DIR ?? realpathSync(mkdtempSync(path.join(os.tmpdir(), "signup-proof-")));
const recoveryDir = process.env.CI ? null : path.join(os.homedir(), ".local", "state", "proplane", "signup-proof-recovery");
if (recoveryDir) {
  mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(recoveryDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error("Private persistent signup recovery destination refused.");
}
const recoveryFile = process.env.SIGNUP_PROOF_RECOVERY_FILE ?? (recoveryDir ? path.join(recoveryDir, `${randomBytes(16).toString("hex")}.enc`) : `${dir}.recovery.enc`);
const env = { ...process.env, AUTH_PROOF_CAPTURE_DIR: dir, SIGNUP_PROOF_RUN_NONCE: process.env.SIGNUP_PROOF_RUN_NONCE ?? randomBytes(16).toString("hex"), SIGNUP_PROOF_RUNNER_PID: String(process.pid), GITHUB_SHA: process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), SIGNUP_PROOF_RECOVERY_FILE: recoveryFile };
const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)], { env, stdio: "inherit", detached: true });
child.on("error", () => undefined);
let interrupted = false;
const stop = () => { interrupted = true; void stopOwnedChild(child, { timeoutMs: 10_000 }).catch(() => undefined); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
let status = 1;
function command(args) {
  return new Promise((resolve) => {
    const finalizer = spawn(process.execPath, args, { env, stdio: "inherit" });
    finalizer.once("error", () => resolve(1)); finalizer.once("exit", (code) => resolve(code ?? 1));
  });
}
try { status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); }); }
finally {
  try {
    const cleanupStatus = await finishOwnedProof(child, {
      writeReceipt: () => writeFileSync(path.join(dir, "tests-stopped.json"), JSON.stringify({ pid: child.pid, runNonce: env.SIGNUP_PROOF_RUN_NONCE }), { flag: "wx", mode: 0o600 }),
      finalize: () => command(["--import", "tsx", "scripts/finalize-signup-proof.ts"]),
      // CI has its own independent always-run encrypted upload step.
      recover: async () => {
        if (process.env.CI) return 0;
        const code = await command(["--import", "tsx", "scripts/package-signup-proof-recovery.ts"]);
        if (code === 0) console.log(`Encrypted signup recovery: ${recoveryFile}`);
        return code;
      },
    });
    if (cleanupStatus !== 0) status = 1;
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    process.exitCode = interrupted ? 143 : status;
  }
}
