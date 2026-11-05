import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recordSignupInventory, type SignupProofManifest } from "../helpers/signup-proof-e2e";

afterEach(() => vi.unstubAllEnvs());
it("retains a fail-stop inventory and rejects cross-actor, cross-namespace and unscoped replacements", () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "p8-inventory-")));
  const nonce = "a".repeat(32), actor = "11111111-1111-4111-8111-111111111111";
  const file = path.join(directory, `p8-${nonce}.manifest.json`);
  const manifest: SignupProofManifest = { schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce, absentBeforeSignup: true, email: `p8-manager-${nonce}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: new Date().toISOString(), actorId: actor };
  try {
    writeFileSync(path.join(directory, "server-ready.json"), JSON.stringify({ origin: "http://localhost:3000", pid: process.pid, wrapperPid: process.pid, runnerPid: process.pid, runNonce: nonce }), { mode: 0o600 });
    writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });
    for (const [key, value] of Object.entries({ SIGNUP_PROOF_ENABLED: "1", SIGNUP_PROOF_RUNNER_PID: String(process.pid), SIGNUP_PROOF_RUN_NONCE: nonce, NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture-key", AUTH_PROOF_CAPTURE_DIR: directory, NEXT_PUBLIC_APP_URL: "http://localhost:3000", PLAYWRIGHT_BASE_URL: "http://localhost:3000" })) vi.stubEnv(key, value);
    const reservation = { manifest, file };
    recordSignupInventory(reservation, { namespace: "property", state: "unresolved", actorId: actor, marker: nonce });
    expect(() => recordSignupInventory(reservation, { namespace: "property", state: "resolved", actorId: "foreign", marker: nonce, id: "foreign" })).toThrow();
    expect(() => recordSignupInventory(reservation, { namespace: "property", state: "resolved", actorId: actor, marker: "foreign", id: "foreign" })).toThrow();
    expect(() => recordSignupInventory(reservation, { namespace: "property", state: "resolved", actorId: actor, marker: nonce })).toThrow();
    recordSignupInventory(reservation, { namespace: "property", state: "resolved", actorId: actor, marker: nonce, id: "property-id" });
    expect(() => recordSignupInventory(reservation, { namespace: "property", state: "resolved", actorId: actor, marker: nonce, id: "other" })).toThrow();
    recordSignupInventory(reservation, { namespace: "resident-threads", state: "unresolved", actorId: actor, marker: nonce, propertyId: "property-id", residentActorId: "22222222-2222-4222-8222-222222222222" });
    const saved = JSON.parse(readFileSync(file, "utf8")) as SignupProofManifest;
    expect(saved.inventory).toEqual([{ namespace: "property", state: "resolved", actorId: actor, marker: nonce, id: "property-id" }, { namespace: "resident-threads", state: "unresolved", actorId: actor, marker: nonce, propertyId: "property-id", residentActorId: "22222222-2222-4222-8222-222222222222" }]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
