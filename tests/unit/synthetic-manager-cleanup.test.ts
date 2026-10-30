import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureSyntheticManagerChildren, cleanupSyntheticManager, type SyntheticManagerManifest } from "../helpers/synthetic-manager-cleanup";

const id = "11111111-1111-4111-8111-111111111111";
const email = "get-started-e2e-123@example.invalid";
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "synthetic-cleanup-")); directories.push(dir);
  const tables: Record<string, Record<string, unknown>[]> = {
    profiles: [{ id, role: "manager" }], profile_roles: [{ user_id: id, role: "manager" }],
    manager_purchases: [{ id: "purchase-1", user_id: id, stripe_checkout_session_id: "axis_intent_11111111-1111-4111-8111-111111111111" }],
    manager_property_records: [],
  };
  const deletes: string[] = [];
  let authDeleted = false;
  const db = {
    auth: { admin: { getUserById: vi.fn(async () => authDeleted ? ({ data: { user: null }, error: { code: "user_not_found" } }) : ({ data: { user: { id, email, app_metadata: { proplane_email_onboarding: true }, identities: [{ provider: "email" }] } }, error: null })), deleteUser: vi.fn(async () => { deletes.push("auth"); authDeleted = true; return { error: null }; }) } },
    from(table: string) {
      const filters: Array<[string, unknown]> = []; let deleting = false;
      const query = {
        select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; }, limit: () => query,
        delete: () => { deleting = true; deletes.push(table); return query; },
        then: (resolve: (value: unknown) => unknown) => {
          const matching = (tables[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value));
          if (deleting) tables[table] = (tables[table] ?? []).filter((row) => !matching.includes(row));
          return resolve({ data: matching, error: null });
        },
      };
      return query;
    },
  };
  const manifest: SyntheticManagerManifest = { email, authId: id, absentBeforeSignup: true, children: [], state: "identified" };
  return { db: db as never, tables, deletes, manifest, file: path.join(dir, "manifest.json") };
}
describe("synthetic manager cleanup preflight", () => {
  it("deletes only captured rows and deletes Auth last after identity verification", async () => {
    const f = fixture();
    await captureSyntheticManagerChildren(f.db, f.manifest, f.file);
    await cleanupSyntheticManager(f.db, "https://emstjswhotsnyksqhqyf.supabase.co", f.manifest, f.file);
    expect(f.deletes).toEqual(["manager_purchases", "profile_roles", "profiles", "auth"]);
    expect(f.manifest.state).toBe("cleaned");
  });
  it("refuses a changed Auth identity before any deletion", async () => {
    const f = fixture();
    const db = f.db as unknown as { auth: { admin: { getUserById: ReturnType<typeof vi.fn> } } };
    db.auth.admin.getUserById.mockResolvedValue({ data: { user: { id, email: "other@example.invalid", app_metadata: { proplane_email_onboarding: true }, identities: [{ provider: "email" }] } }, error: null });
    await expect(cleanupSyntheticManager(f.db, "https://emstjswhotsnyksqhqyf.supabase.co", f.manifest, f.file)).rejects.toThrow(/ownership/);
    expect(f.deletes).toEqual([]);
  });
  it("refuses an external Stripe reference before any deletion", async () => {
    const f = fixture(); f.tables.manager_purchases[0]!.stripe_checkout_session_id = "cs_live_external";
    await expect(cleanupSyntheticManager(f.db, "https://emstjswhotsnyksqhqyf.supabase.co", f.manifest, f.file)).rejects.toThrow(/external payment/);
    expect(f.deletes).toEqual([]);
  });
  it("refuses a child whose ownership changed after the recorded snapshot", async () => {
    const f = fixture();
    await captureSyntheticManagerChildren(f.db, f.manifest, f.file);
    f.tables.manager_purchases[0]!.user_id = "22222222-2222-4222-8222-222222222222";
    await expect(cleanupSyntheticManager(f.db, "https://emstjswhotsnyksqhqyf.supabase.co", f.manifest, f.file)).rejects.toThrow(/linked rows changed/);
    expect(f.deletes).toEqual([]);
  });
  it("refuses unsupported property data before any deletion", async () => {
    const f = fixture(); f.tables.manager_property_records.push({ id: "property-1", manager_user_id: id });
    await expect(cleanupSyntheticManager(f.db, "https://emstjswhotsnyksqhqyf.supabase.co", f.manifest, f.file)).rejects.toThrow(/Unexpected synthetic linked row/);
    expect(f.deletes).toEqual([]);
  });
});
