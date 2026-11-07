import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
// Pure transaction harness. No network or real database operations.
import { CANONICAL_PHONE_FIXTURES, prepareCanonicalPhonePrerequisites, validateCanonicalPhoneInput } from "../helpers/seed-canonical-phone-prerequisites.mjs";
const ids = { manager2: "11111111-1111-4111-8111-111111111111", marcus: "22222222-2222-4222-8222-222222222222", jordan: "33333333-3333-4333-8333-333333333333" };
const url = "https://emstjswhotsnyksqhqyf.supabase.co";
function database({ ready = false, conflict = false, wrongIdentity = false, foreignPhone = false, verifiedForeign = false } = {}) {
  const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> => {
    if (sql.includes("from public.profiles p join auth.users")) {
      const f = CANONICAL_PHONE_FIXTURES.find((fixture) => fixture.email === values[0])!;
      return { rows: [{ id: ids[f.label as keyof typeof ids], email: f.email, auth_email: f.email,
        manager_id: wrongIdentity ? "wrong" : f.axisId, role: f.role, roles: [f.role],
        phone: foreignPhone ? "+12025550199" : ready ? f.phone : null, phone_verified_at: ready || verifiedForeign ? "2026-01-01" : null,
        auth_phone: null, phone_confirmed_at: null }] };
    }
    if (sql.includes("as profile_phone")) return { rows: [{ profile_phone: values[0], auth_phone: null }] };
    if (sql.includes("as profiles,")) return { rows: [{ profiles: 0, auth: 0, contacts: conflict ? 1 : 0, other_contacts: 0, operations: 0 }] };
    if (sql.startsWith("update public.profiles")) return { rows: [{ id: values[1] }], rowCount: 1 };
    if (sql.includes("where id=any")) return { rows: CANONICAL_PHONE_FIXTURES.map((f) => ({ id: ids[f.label as keyof typeof ids], phone: f.phone, verified: true })) };
    return { rows: [] };
  });
  return { query };
}
describe("bounded existing canonical phone preparation", () => {
  it("refuses non-DEV and noncanonical identity overrides", () => {
    expect(() => validateCanonicalPhoneInput({ url: "https://production.invalid", env: {} })).toThrow();
    expect(() => validateCanonicalPhoneInput({ url, env: { E2E_MANAGER2_EMAIL: "personal@example.test" } })).toThrow();
    expect(() => validateCanonicalPhoneInput({ url, apply: true, env: {} })).toThrow();
    expect(() => validateCanonicalPhoneInput({ url, apply: true, expectedIds: { ...ids, marcus: ids.manager2 }, env: {} })).toThrow();
  });
  it("inventories the exact three existing actors with no writes in default dry-run", async () => {
    const db = database();
    const result = await prepareCanonicalPhonePrerequisites(db, { url, env: {} });
    expect(result.applied).toBe(false);
    expect(result.fixtures).toHaveLength(3);
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("update "))).toBe(false);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it.each([{ conflict: true }, { wrongIdentity: true }, { foreignPhone: true }])("rejects unsafe inventory before any mutation: %j", async (failure) => {
    const db = database(failure);
    await expect(prepareCanonicalPhonePrerequisites(db, { url, apply: true, expectedIds: ids, env: {} })).rejects.toThrow();
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("update "))).toBe(false);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("writes only the three reviewed profiles and requires successful readback", async () => {
    const db = database();
    const result = await prepareCanonicalPhonePrerequisites(db, { url, apply: true, expectedIds: ids, env: {} });
    const updates = db.query.mock.calls.filter(([sql]) => sql.startsWith("update "));
    expect(updates).toHaveLength(3);
    expect(updates.map(([, values]) => values?.[1])).toEqual(Object.values(ids));
    expect(result.fixtures.every((f: { readyAfter: boolean }) => f.readyAfter)).toBe(true);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("allows replacing only reviewed unverified profile values and never verified identity", async () => {
    const digest = createHash("sha256").update(JSON.stringify("+12025550199")).digest("hex");
    const phoneDigests = { manager2: digest, marcus: digest, jordan: digest };
    const db = database({ foreignPhone: true });
    const dry = await prepareCanonicalPhonePrerequisites(db, { url, env: {} });
    expect(dry.fixtures.every((f: { replacingUnverified: boolean; phoneDigest: string }) => f.replacingUnverified && f.phoneDigest === digest)).toBe(true);
    await prepareCanonicalPhonePrerequisites(db, { url, apply: true, expectedIds: ids, expectedPhoneDigests: phoneDigests, env: {} });
    expect(db.query.mock.calls.filter(([sql]) => sql.startsWith("update "))).toHaveLength(3);
    const bound = database({ foreignPhone: true, verifiedForeign: true });
    await expect(prepareCanonicalPhonePrerequisites(bound, { url, apply: true, expectedIds: ids, expectedPhoneDigests: phoneDigests, env: {} })).rejects.toThrow();
    expect(bound.query.mock.calls.some(([sql]) => sql.startsWith("update "))).toBe(false);
  });
  it("is idempotent for already seeded verified phones", async () => {
    const db = database({ ready: true });
    await prepareCanonicalPhonePrerequisites(db, { url, apply: true, expectedIds: ids, env: {} });
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("update "))).toBe(false);
  });
});
