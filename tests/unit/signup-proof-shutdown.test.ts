import { mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { proveSignupShutdown } from "../helpers/signup-proof-shutdown";
it("requires stopped server and wrapper, exact run nonce, no stale readiness", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "signup-stop-")));
  const nonce = "a".repeat(32), origin = "http://localhost:3000";
  const proof = { origin, pid: 123, wrapperPid: 456, runNonce: nonce, portClosed: true };
  const absent = vi.fn(() => true);
  try {
    const file = path.join(dir, "server-stopped.json");
    writeFileSync(file, JSON.stringify(proof), { mode: 0o600 });
    writeFileSync(path.join(dir, "tests-stopped.json"), JSON.stringify({ pid: 789, runNonce: nonce }), { mode: 0o600 });
    expect(() => proveSignupShutdown(dir, origin, nonce, absent)).not.toThrow();
    expect(absent.mock.calls).toEqual([[123], [456], [789]]);
    expect(() => proveSignupShutdown(dir, origin, nonce, () => false)).toThrow();
    expect(() => proveSignupShutdown(dir, origin, "b".repeat(32), absent)).toThrow();
    writeFileSync(path.join(dir, "server-ready.json"), "{}", { mode: 0o600 });
    expect(() => proveSignupShutdown(dir, origin, nonce, absent)).toThrow();
    unlinkSync(path.join(dir, "server-ready.json"));
    writeFileSync(file, JSON.stringify({ ...proof, portClosed: false }), { mode: 0o600 });
    expect(() => proveSignupShutdown(dir, origin, nonce, absent)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
