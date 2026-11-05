import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { identifySignupActor, persistSignupJournal, type SignupJournal } from "../helpers/signup-proof-journal";

const actor = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "signup-journal-"));
  const nonce = "a".repeat(32);
  const manifest: SignupJournal = { schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce, absentBeforeSignup: true, email: `p8-manager-${nonce}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: "2026-01-01T00:00:00.000Z" };
  return { dir, file: path.join(dir, `p8-${nonce}.manifest.json`), manifest };
}
function db(users: unknown[], error: unknown = null): SupabaseClient {
  return { auth: { admin: { listUsers: async () => ({ data: { users }, error }) } } } as unknown as SupabaseClient;
}
const user = { id: actor, email: `p8-manager-${"a".repeat(32)}-draft@example.invalid`, created_at: "2026-01-01T00:00:01.000Z", app_metadata: { proplane_email_onboarding: true }, identities: [{ provider: "email" }] };
it("persists a private atomic reservation and reconciles an actor even after a failed start response", async () => {
  const f = fixture();
  try {
    persistSignupJournal(f.file, f.manifest);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(await identifySignupActor(db([user]), f)).toBe(actor);
    expect(JSON.parse(readFileSync(f.file, "utf8")).actorId).toBe(actor);
    expect(await identifySignupActor(db([user]), f)).toBe(actor);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("refuses ambiguous, foreign, changed and failed Auth reads without overwriting the journal", async () => {
  const f = fixture();
  try {
    persistSignupJournal(f.file, f.manifest);
    const before = readFileSync(f.file, "utf8");
    for (const client of [db([user, user]), db([{ ...user, created_at: "2025-01-01" }]), db([{ ...user, app_metadata: {} }]), db([{ ...user, identities: [{ provider: "google" }] }]), db([{ ...user, identities: undefined }]), db([], new Error("secret"))]) {
      await expect(identifySignupActor(client, f)).rejects.toThrow("Signup recovery journal refused.");
      expect(readFileSync(f.file, "utf8")).toBe(before);
    }
    expect(await identifySignupActor(db([]), f)).toBeNull();
    await identifySignupActor(db([user]), f);
    await expect(identifySignupActor(db([]), f)).rejects.toThrow();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("refuses untrusted fields and immutable identity changes without including their values in diagnostics", () => {
  const f = fixture();
  try {
    persistSignupJournal(f.file, f.manifest);
    const before = readFileSync(f.file, "utf8");
    expect(() => persistSignupJournal(f.file, { ...f.manifest, access_token: "SECRET" } as SignupJournal)).toThrow("Signup recovery journal refused.");
    expect(() => persistSignupJournal(f.file, { ...f.manifest, phone: "+12065550101" })).toThrow();
    expect(readFileSync(f.file, "utf8")).toBe(before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("records an immutable exact pair before related mutations", async () => {
  const { linkSignupJournals, readSignupJournal } = await import("../helpers/signup-proof-journal");
  const manager = fixture();
  const nonce = "b".repeat(32);
  const resident = { file: path.join(manager.dir, `p8-${nonce}.manifest.json`), manifest: { ...manager.manifest, nonce, email: `p8-resident-${nonce}-resident@example.invalid`, fullName: "P8 resident manager", tier: "resident" as const, actorId: "22222222-2222-4222-8222-222222222222" } };
  manager.manifest.actorId = actor;
  try {
    persistSignupJournal(manager.file, manager.manifest); persistSignupJournal(resident.file, resident.manifest);
    linkSignupJournals(manager, resident);
    expect(readSignupJournal(manager.file).pairedActorId).toBe(resident.manifest.actorId);
    expect(readSignupJournal(resident.file).pairedNonce).toBe(manager.manifest.nonce);
    expect(() => persistSignupJournal(manager.file, { ...manager.manifest, pairedActorId: "33333333-3333-4333-8333-333333333333" })).toThrow();
  } finally { rmSync(manager.dir, { recursive: true, force: true }); }
});
it("persists current and legacy manager IDs and freezes realistic thread IDs", async () => {
  const { readSignupJournal } = await import("../helpers/signup-proof-journal");
  const { generateManagerId } = await import("@/lib/manager-id");
  const f = fixture();
  try {
    f.manifest.actorId = actor;
    f.manifest.managerAxisId = generateManagerId();
    f.manifest.inventory = [{ namespace: "resident-threads", state: "resolved", actorId: actor, marker: `threads_${f.manifest.nonce}`, ids: [`app_submit_PROPLANE-ABCDEF12_${actor}`, "PROPLANE-12345678"] }];
    persistSignupJournal(f.file, f.manifest);
    expect(readSignupJournal(f.file).inventory?.[0]?.ids).toEqual(f.manifest.inventory[0]?.ids);
    expect(() => persistSignupJournal(f.file, { ...f.manifest, managerAxisId: "AXIS-ABCDEF12" })).toThrow();
    expect(() => persistSignupJournal(f.file, { ...f.manifest, inventory: [{ ...f.manifest.inventory![0]!, ids: [] }] })).toThrow();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
  const legacy = fixture();
  try { legacy.manifest.managerAxisId = "AXIS-ABCDEF12"; persistSignupJournal(legacy.file, legacy.manifest); expect(readSignupJournal(legacy.file).managerAxisId).toBe("AXIS-ABCDEF12"); }
  finally { rmSync(legacy.dir, { recursive: true, force: true }); }
  const empty = fixture();
  try { empty.manifest.actorId = actor; empty.manifest.inventory = [{ namespace: "resident-threads", state: "resolved", actorId: actor, marker: `threads_${empty.manifest.nonce}`, ids: [] }]; persistSignupJournal(empty.file, empty.manifest); expect(readSignupJournal(empty.file).inventory?.[0]?.ids).toEqual([]); }
  finally { rmSync(empty.dir, { recursive: true, force: true }); }
});
