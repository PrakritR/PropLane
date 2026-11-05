import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { packageSignupRecovery, decryptSignupRecovery } from "../../scripts/package-signup-proof-recovery";
import { persistSignupJournal, type SignupJournal } from "../helpers/signup-proof-journal";

it("durably encrypts only validated journal state and excludes late bearer captures", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "signup-recovery-")));
  const nonce = "a".repeat(32), sha = "b".repeat(40), key = "c".repeat(64);
  const output = path.join(dir, "recovery.enc");
  const journal: SignupJournal = { schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce, absentBeforeSignup: true, email: `p8-manager-${nonce}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: "2026-01-01T00:00:00Z" };
  try {
    persistSignupJournal(path.join(dir, `p8-${nonce}.manifest.json`), journal);
    writeFileSync(path.join(dir, `${"d".repeat(64)}.json`), JSON.stringify({ href: "http://localhost/auth/confirm?token_hash=private-proof" }), { mode: 0o600 });
    expect(packageSignupRecovery(dir, output, key, sha)).toBe(1);
    const encrypted = readFileSync(output, "utf8");
    expect(encrypted).not.toContain(journal.email);
    expect(encrypted).not.toContain("private-proof");
    expect(decryptSignupRecovery(output, key, sha)).toEqual({ format: "proplane-signup-proof-recovery/v1", sha, journals: [journal] });
    expect(() => decryptSignupRecovery(output, "e".repeat(64), sha)).toThrow();
    expect(() => decryptSignupRecovery(output, key, "f".repeat(40))).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("refuses credential-bearing malformed journal without creating an artifact", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "signup-recovery-")));
  try {
    writeFileSync(path.join(dir, `p8-${"a".repeat(32)}.manifest.json`), JSON.stringify({ token_hash: "secret" }), { mode: 0o600 });
    expect(() => packageSignupRecovery(dir, path.join(dir, "recovery.enc"), "c".repeat(64), "b".repeat(40))).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("round trips current manager and application identities with multiple opaque threads", async () => {
  const { generateManagerId } = await import("@/lib/manager-id");
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "signup-recovery-")));
  const nonce = "a".repeat(32), sha = "b".repeat(40), key = "c".repeat(64);
  const actor = "11111111-1111-4111-8111-111111111111";
  const resident = "22222222-2222-4222-8222-222222222222";
  const journal: SignupJournal = {
    schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce, absentBeforeSignup: true,
    email: `p8-manager-${nonce}-listing@example.invalid`, phone: "+12065550100", fullName: "P8 listing manager", tier: "pro", startedAt: "2026-01-01T00:00:00Z",
    actorId: actor, managerAxisId: generateManagerId(), pairedActorId: resident, pairedNonce: "d".repeat(32),
    inventory: [
      { namespace: "application", state: "resolved", actorId: actor, marker: `application_${nonce}`, id: "PROPLANE-ABCDEF12", residentActorId: resident },
      { namespace: "resident-threads", state: "resolved", actorId: actor, marker: `threads_${nonce}`, ids: [`app_submit_PROPLANE-ABCDEF12_${resident}`, `app_submit_PROPLANE-ABCDEF12_${actor}`] },
    ],
  };
  try {
    persistSignupJournal(path.join(dir, `p8-${nonce}.manifest.json`), journal);
    const output = path.join(dir, "recovery.enc");
    expect(packageSignupRecovery(dir, output, key, sha)).toBe(1);
    const encrypted = readFileSync(output, "utf8");
    for (const value of [journal.email, journal.managerAxisId!, "PROPLANE-ABCDEF12", "app_submit_"]) expect(encrypted).not.toContain(value);
    expect(decryptSignupRecovery(output, key, sha)).toEqual({ format: "proplane-signup-proof-recovery/v1", sha, journals: [journal] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
