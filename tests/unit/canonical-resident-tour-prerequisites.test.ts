import { describe, expect, it, vi } from "vitest";
import { CANONICAL_RESIDENT_TOUR as fixture, canonicalTourThreads, prepareCanonicalResidentTour } from "../helpers/seed-canonical-resident-tour.mjs";
const ids = { manager2: "11111111-1111-4111-8111-111111111111", resident: "22222222-2222-4222-8222-222222222222", workspaceId: "33333333-3333-4333-8333-333333333333" };
const url = "https://emstjswhotsnyksqhqyf.supabase.co";
function database({ existing = false, foreignConversation = false, wrongOwner = false, bindingRefused = false, residentAxisId = "PROPLANE-3C022893" } = {}) {
  const original = { id: "unrelated-real-inquiry", email: "unrelated@example.test", retained: true };
  const inquiry = { id: fixture.inquiryId, e2eFixture: fixture.marker, email: fixture.residentEmail, propertyId: fixture.propertyId, managerUserId: ids.manager2, kind: "tour" };
  const threads = canonicalTourThreads({ manager: { id: ids.manager2, name: "Test Manager 2" }, resident: { id: ids.resident, name: "Test Resident" }, workspaceId: ids.workspaceId, propertyTitle: "Magnolia House — 5 rooms" });
  const query = vi.fn(async (sql: string, _values: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> => {
    void _values;
    if (sql.includes("from public.profiles p join auth.users")) return { rows: [
      { id: ids.manager2, email: fixture.managerEmail, manager_id: "MGR-TESTE2E2", roles: ["manager"], full_name: "Test Manager 2" },
      { id: ids.resident, email: fixture.residentEmail, manager_id: residentAxisId, roles: ["resident"], full_name: "Test Resident" },
    ] };
    if (sql.includes("join public.portal_workspaces")) return { rows: [{ id: fixture.propertyId, manager_user_id: wrongOwner ? ids.resident : ids.manager2, workspace_id: ids.workspaceId, owner_user_id: ids.manager2, is_default: true, is_service: false, property_data: { title: "Magnolia House — 5 rooms" } }] };
    if (sql.startsWith("select id from public.portal_workspaces")) return { rows: [] };
    if (sql.includes("select row_data from public.portal_schedule_records")) return { rows: [{ row_data: { payload: existing ? [original, inquiry] : [original], retainedRoot: true } }] };
    if (sql.startsWith("select * from public.resident_tour_links")) return { rows: existing ? [{ resident_user_id: ids.resident, manager_user_id: ids.manager2, property_id: fixture.propertyId, attendee_email: fixture.residentEmail }] : [] };
    if (sql.startsWith("select id,owner_user_id")) return { rows: foreignConversation ? [{ id: "existing-shared-thread" }] : existing ? threads.map((t: { id: string; ownerUserId: string; scope: string; rowData: unknown; workspaceId: string; conversationKey: string }) => ({ id: t.id, owner_user_id: t.ownerUserId, scope: t.scope, row_data: t.rowData, workspace_id: t.workspaceId, conversation_key: t.conversationKey })) : [] };
    if (sql.startsWith("select public.bind_resident_tour_link")) return { rows: [{ bound: !bindingRefused }] };
    if (sql.startsWith("select (select count")) return { rows: [{ links: 1, threads: 2 }] };
    return { rows: [], rowCount: 1 };
  });
  return { query, original };
}
describe("canonical resident tour seed boundary", () => {
  it("dry-run accepts the audited existing resident identity without profile writes", async () => {
    const db = database();
    const result = await prepareCanonicalResidentTour(db, { url, env: {} });
    expect(result.applied).toBe(false);
    expect(db.query.mock.calls.some(([sql]) => /^(insert|update)/.test(sql))).toBe(false);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it.each(["AXIS-TESTRSID", "PROPLANE-FOREIGN"])("rejects mismatched resident Axis identity %s before writes", async (residentAxisId) => {
    const db = database({ residentAxisId });
    await expect(prepareCanonicalResidentTour(db, { url, apply: true, expectedIds: ids, env: {} })).rejects.toThrow("Canonical existing tour actor mismatch.");
    expect(db.query.mock.calls.some(([sql]) => /^(insert|update)/.test(sql))).toBe(false);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("creates exactly two scoped conversation sides and preserves unrelated inquiry payload", async () => {
    const db = database();
    await prepareCanonicalResidentTour(db, { url, apply: true, expectedIds: ids, env: {} });
    const update = db.query.mock.calls.find(([sql]) => sql.startsWith("update public.portal_schedule_records")) as unknown as [string, unknown[]];
    const payload = JSON.parse(update[1][1] as string);
    expect(payload.retainedRoot).toBe(true);
    expect(payload.payload[0]).toEqual(db.original);
    expect(payload.payload[1]).toMatchObject({ id: fixture.inquiryId, email: fixture.residentEmail, smsConsent: false, noticeChannel: "portal" });
    expect(db.query.mock.calls.filter(([sql]) => sql.startsWith("insert into public.portal_inbox_thread_records"))).toHaveLength(2);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("does not rewrite already-existing fixture messages or relationships", async () => {
    const db = database({ existing: true });
    await prepareCanonicalResidentTour(db, { url, apply: true, expectedIds: ids, env: {} });
    expect(db.query.mock.calls.some(([sql]) => /^(insert|update)/.test(sql))).toBe(false);
  });
  it.each([{ foreignConversation: true }, { wrongOwner: true }])("rejects unrelated identity/ownership before writes: %j", async (failure) => {
    const db = database(failure);
    await expect(prepareCanonicalResidentTour(db, { url, apply: true, expectedIds: ids, env: {} })).rejects.toThrow();
    expect(db.query.mock.calls.some(([sql]) => /^(insert|update)/.test(sql))).toBe(false);
  });
  it("rolls back when the actual resident link binder refuses", async () => {
    const db = database({ bindingRefused: true });
    await expect(prepareCanonicalResidentTour(db, { url, apply: true, expectedIds: ids, env: {} })).rejects.toThrow();
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("insert into public.portal_inbox"))).toBe(false);
  });
  it("refuses non-DEV and mismatched reviewed IDs", async () => {
    const db = database();
    await expect(prepareCanonicalResidentTour(db, { url: "https://production.invalid", env: {} })).rejects.toThrow();
    await expect(prepareCanonicalResidentTour(db, { url, apply: true, env: {} })).rejects.toThrow();
    await expect(prepareCanonicalResidentTour(db, { url, apply: true, expectedIds: { ...ids, manager2: ids.resident }, env: {} })).rejects.toThrow();
    expect(db.query.mock.calls.some(([sql]) => /^(insert|update)/.test(sql))).toBe(false);
  });
});
