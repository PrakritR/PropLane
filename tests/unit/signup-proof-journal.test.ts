import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { identifySignupActor, persistSignupJournal, type SignupJournal } from "../helpers/signup-proof-journal";

const actor = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "signup-journal-"));
  const nonce = "a".repeat(32);
  const manifest: SignupJournal = { schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce, absentBeforeSignup: true, email: `p8-manager-${nonce}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: "2026-01-01T00:00:00.000Z" };
  return { dir, file: path.join(dir, `p8-${nonce}.manifest.json`), manifest };
}
const user = { id: actor, email: `p8-manager-${"a".repeat(32)}-draft@example.invalid`, created_at: "2026-01-01T00:00:01.000Z", app_metadata: { proplane_email_onboarding: true }, identities: [{ provider: "email" }] };
const sparseUser = { id: user.id, email: user.email.toUpperCase(), created_at: user.created_at, app_metadata: user.app_metadata };
function db(users: unknown[], options: { listError?: boolean; listThrow?: boolean; detailResponse?: unknown; detailThrow?: boolean } = {}) {
  const listUsers = vi.fn(async () => {
    if (options.listThrow) throw new Error("private provider payload");
    return { data: { users }, error: options.listError ? new Error("private provider payload") : null };
  });
  const getUserById = vi.fn(async () => {
    if (options.detailThrow) throw new Error("private provider payload");
    return "detailResponse" in options ? options.detailResponse : { data: { user }, error: null };
  });
  return { client: { auth: { admin: { listUsers, getUserById } } } as unknown as SupabaseClient, listUsers, getUserById };
}
it("hydrates a sparse list projection by exact UUID and persists a private actor, including repeated reconciliation", async () => {
  const f = fixture();
  const api = db([sparseUser]);
  try {
    persistSignupJournal(f.file, f.manifest);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(await identifySignupActor(api.client, f)).toBe(actor);
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toMatchObject({ actorId: actor, actorCreatedAt: user.created_at });
    expect(f.manifest).toMatchObject({ actorId: actor, actorCreatedAt: user.created_at });
    expect(api.getUserById).toHaveBeenCalledExactlyOnceWith(actor);
    expect(await identifySignupActor(api.client, f)).toBe(actor);
    expect(api.getUserById).toHaveBeenCalledTimes(2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it.each([
  ["duplicates", [sparseUser, sparseUser], {}],
  ["invalid candidate UUID", [{ ...sparseUser, id: "private invalid UUID" }], {}],
  ["list error", [], { listError: true }],
  ["list throw", [], { listThrow: true }],
] as const)("refuses %s before hydration and preserves memory and disk", async (_name, users, options) => {
  const f = fixture();
  const api = db([...users], options);
  try {
    persistSignupJournal(f.file, f.manifest);
    const before = readFileSync(f.file, "utf8"), memory = structuredClone(f.manifest);
    await expect(identifySignupActor(api.client, f)).rejects.toThrow(/^Signup recovery journal refused\.$/);
    expect(api.getUserById).not.toHaveBeenCalled();
    expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.manifest).toEqual(memory);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("completes bounded pagination before hydration and refuses an incomplete scan", async () => {
  const f = fixture();
  const page = Array.from({ length: 1000 }, () => ({ email: "unrelated@example.invalid" }));
  const api = db(page);
  try {
    persistSignupJournal(f.file, f.manifest);
    const before = readFileSync(f.file, "utf8"), memory = structuredClone(f.manifest);
    await expect(identifySignupActor(api.client, f)).rejects.toThrow(/^Signup recovery journal refused\.$/);
    expect(api.listUsers).toHaveBeenCalledTimes(1000); expect(api.getUserById).not.toHaveBeenCalled();
    expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.manifest).toEqual(memory);
    api.listUsers.mockReset(); api.listUsers.mockResolvedValueOnce({ data: { users: [sparseUser, ...page.slice(1)] }, error: null }).mockResolvedValueOnce({ data: { users: [] }, error: null });
    expect(await identifySignupActor(api.client, f)).toBe(actor);
    expect(api.listUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 1000 });
    expect(api.getUserById).toHaveBeenCalledExactlyOnceWith(actor);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("returns null for no match and refuses disappearance or conflict with an existing journal actor before hydration", async () => {
  const f = fixture();
  try {
    persistSignupJournal(f.file, f.manifest);
    const absent = db([]);
    expect(await identifySignupActor(absent.client, f)).toBeNull(); expect(absent.getUserById).not.toHaveBeenCalled();
    await identifySignupActor(db([sparseUser]).client, f);
    const before = readFileSync(f.file, "utf8"), memory = structuredClone(f.manifest);
    for (const api of [db([]), db([{ ...sparseUser, id: "22222222-2222-4222-8222-222222222222" }])]) {
      await expect(identifySignupActor(api.client, f)).rejects.toThrow(/^Signup recovery journal refused\.$/);
      expect(api.getUserById).not.toHaveBeenCalled();
      expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.manifest).toEqual(memory);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
const invalidDetails: Array<[string, unknown]> = [
  ["wrong id", { ...user, id: "22222222-2222-4222-8222-222222222222" }],
  ["missing id", { ...user, id: undefined }],
  ["wrong email", { ...user, email: "private@example.invalid" }],
  ["missing email", { ...user, email: undefined }],
  ["nonstring email", { ...user, email: 123 }],
  ["invalid creation time", { ...user, created_at: "private invalid time" }],
  ["missing creation time", { ...user, created_at: undefined }],
  ["nonstring creation time", { ...user, created_at: 123 }],
  ["before reservation", { ...user, created_at: "2025-01-01T00:00:00.000Z" }],
  ["cross-read creation change", { ...user, created_at: "2026-01-01T00:00:02.000Z" }],
  ["missing marker", { ...user, app_metadata: {} }],
  ["false marker", { ...user, app_metadata: { proplane_email_onboarding: false } }],
  ["missing identities", { ...user, identities: undefined }],
  ["null identities", { ...user, identities: null }],
  ["empty identities", { ...user, identities: [] }],
  ["nonarray identities", { ...user, identities: {} }],
  ["malformed identity", { ...user, identities: [null] }],
  ["primitive identity", { ...user, identities: ["email"] }],
  ["missing provider", { ...user, identities: [{}] }],
  ["foreign provider", { ...user, identities: [{ provider: "google" }] }],
  ["mixed providers", { ...user, identities: [{ provider: "email" }, { provider: "phone" }] }],
  ["null user", null], ["primitive user", "private provider payload"], ["array user", []],
];
it.each(invalidDetails)("refuses authoritative detail with %s without changing memory or disk", async (_name, detail) => {
  const f = fixture();
  const api = db([sparseUser], { detailResponse: { data: { user: detail }, error: null } });
  try {
    persistSignupJournal(f.file, f.manifest);
    const before = readFileSync(f.file, "utf8"), memory = structuredClone(f.manifest);
    await expect(identifySignupActor(api.client, f)).rejects.toThrow(/^Signup recovery journal refused\.$/);
    expect(api.getUserById).toHaveBeenCalledExactlyOnceWith(actor);
    expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.manifest).toEqual(memory);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it.each([
  ["error", { detailResponse: { data: { user }, error: new Error("private provider payload") } }],
  ["throw", { detailThrow: true }],
  ["missing response", { detailResponse: undefined }],
  ["null response", { detailResponse: null }],
  ["missing data", { detailResponse: {} }],
  ["null data", { detailResponse: { data: null } }],
  ["missing user", { detailResponse: { data: {} } }],
] as const)("refuses detail %s without retry or persistence", async (_name, options) => {
  const f = fixture(); const api = db([sparseUser], options);
  try {
    persistSignupJournal(f.file, f.manifest);
    const before = readFileSync(f.file, "utf8"), memory = structuredClone(f.manifest);
    await expect(identifySignupActor(api.client, f)).rejects.toThrow(/^Signup recovery journal refused\.$/);
    expect(api.getUserById).toHaveBeenCalledExactlyOnceWith(actor);
    expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.manifest).toEqual(memory);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("refuses immutable journal creation conflicts before changing memory or disk", async () => {
  const f = fixture();
  try {
    f.manifest.actorId = actor; f.manifest.actorCreatedAt = "2026-01-01T00:00:02.000Z";
    persistSignupJournal(f.file, f.manifest);
    const before = readFileSync(f.file, "utf8"), memory = structuredClone(f.manifest);
    await expect(identifySignupActor(db([sparseUser]).client, f)).rejects.toThrow(/^Signup recovery journal refused\.$/);
    expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.manifest).toEqual(memory);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it.each(["2025-01-01T00:00:00.000Z", "invalid"])("refuses matching list/detail creation time %s without changing memory or disk", async (created_at) => {
  const f = fixture();
  const api = db([{ ...sparseUser, created_at }], { detailResponse: { data: { user: { ...user, created_at } }, error: null } });
  try {
    persistSignupJournal(f.file, f.manifest);
    const before = readFileSync(f.file, "utf8"), memory = structuredClone(f.manifest);
    await expect(identifySignupActor(api.client, f)).rejects.toThrow(/^Signup recovery journal refused\.$/);
    expect(api.getUserById).toHaveBeenCalledExactlyOnceWith(actor);
    expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.manifest).toEqual(memory);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
it("preserves in-memory identity when the atomic writer refuses a conflicting on-disk journal", async () => {
  const f = fixture();
  try {
    persistSignupJournal(f.file, { ...f.manifest, actorId: "22222222-2222-4222-8222-222222222222" });
    const before = readFileSync(f.file, "utf8"), memory = structuredClone(f.manifest);
    await expect(identifySignupActor(db([sparseUser]).client, f)).rejects.toThrow(/^Signup recovery journal refused\.$/);
    expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.manifest).toEqual(memory);
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
