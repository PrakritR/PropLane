import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { signupProofEnvironment } from "../helpers/signup-proof-e2e";

afterEach(() => vi.unstubAllEnvs());
it("refuses a stale readiness marker even if its old process is still live", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "signup-ready-")));
  const nonce = "a".repeat(32);
  try {
    for (const [key, value] of Object.entries({ SIGNUP_PROOF_ENABLED: "1", SIGNUP_PROOF_RUNNER_PID: String(process.pid), SIGNUP_PROOF_RUN_NONCE: nonce, NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture", AUTH_PROOF_CAPTURE_DIR: dir, NEXT_PUBLIC_APP_URL: "http://localhost:3000", PLAYWRIGHT_BASE_URL: "http://localhost:3000" })) vi.stubEnv(key, value);
    const marker = path.join(dir, "server-ready.json");
    writeFileSync(marker, JSON.stringify({ origin: "http://localhost:3000", pid: process.pid, wrapperPid: process.pid, runnerPid: process.pid, runNonce: "b".repeat(32) }), { mode: 0o600 });
    expect(() => signupProofEnvironment()).toThrow("proof is invalid");
    writeFileSync(marker, JSON.stringify({ origin: "http://localhost:3000", pid: process.pid, wrapperPid: process.pid, runnerPid: process.pid, runNonce: nonce }), { mode: 0o600 });
    expect(signupProofEnvironment().dir).toBe(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
