import { describe, expect, it, vi } from "vitest";
import { PUBLIC_TOUR_FIXTURE as f, mergePublicTourHosts, preparePublicTourFixture, publicTourFixtureData } from "../helpers/seed-public-tour-fixture.mjs";
const url = "https://emstjswhotsnyksqhqyf.supabase.co";
const owner = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-11-08T04:00:00Z"); // Still November 7 in Pacific.
function database({ partial = false, foreignMarker = false, foreignOwner = false, noIdentity = false } = {}) {
  const shape = publicTourFixtureData(owner, now);
  let user: Record<string, unknown> | undefined = noIdentity ? undefined : { id: owner, email: f.managerEmail, raw_app_meta_data: { e2eFixture: foreignMarker ? "foreign" : f.marker } };
  let profile: Record<string, unknown> | undefined = partial ? undefined : { id: owner, email: f.managerEmail, manager_id: f.managerAxisId, role: "manager", full_name: "Synthetic Public Tour Manager", roles: ["manager"] };
  let workspace: Record<string, unknown> | undefined = partial ? undefined : { id: f.workspaceId, owner_user_id: owner, name: `Public tours fixture (${f.marker})`, is_default: true, is_service: false };
  let property: Record<string, unknown> | undefined = partial ? undefined : { id: f.propertyId, manager_user_id: foreignOwner ? "foreign" : owner, workspace_id: f.workspaceId, test_workspace_id: null, status: "live", property_data: shape.property, row_data: { e2eFixture: f.marker } };
  let schedule: Record<string, unknown> | undefined = partial ? undefined : { id: shape.scheduleId, manager_user_id: owner, property_id: f.propertyId, record_type: "manager_property_availability", test_workspace_id: null, row_data: { e2eFixture: f.marker, retained: true, payload: ["2026-11-09:22"] } };
  const sibling = [{ userId: "another-owner", label: "Preserve me" }];
  let registry = { record_type: "axis_property_mgr_registry_v1", test_workspace_id: null, row_data: { payload: { sibling }, retained: true } };
  const query = vi.fn(async (sql: string, args: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    if (sql.includes("from auth.users")) return { rows: user ? [user] : [] };
    if (sql.includes("from public.profiles p")) return { rows: profile ? [profile] : [] };
    if (sql.includes("from public.portal_workspaces")) return { rows: workspace ? [workspace] : [] };
    if (sql.includes("from public.manager_property_records")) return { rows: property ? [property] : [] };
    if (sql.includes("select * from public.portal_schedule_records")) return { rows: args[0] === "axis_property_mgr_registry_v1" ? [registry] : schedule ? [schedule] : [] };
    if (sql.startsWith("insert into public.profiles")) profile = { id: owner, email: f.managerEmail, manager_id: f.managerAxisId, role: "manager", full_name: "Synthetic Public Tour Manager", roles: [] };
    if (sql.startsWith("insert into public.profile_roles")) profile!.roles = ["manager"];
    if (sql.startsWith("insert into public.portal_workspaces")) workspace = { id: f.workspaceId, owner_user_id: owner, name: args[2], is_default: true, is_service: false };
    if (sql.startsWith("insert into public.manager_property_records")) property = { id: f.propertyId, manager_user_id: owner, workspace_id: f.workspaceId, status: "live", test_workspace_id: null, property_data: JSON.parse(args[3] as string), row_data: JSON.parse(args[4] as string) };
    if (sql.startsWith("insert into public.portal_schedule_records")) {
      if (args[0] === "axis_property_mgr_registry_v1") registry = { ...registry, row_data: JSON.parse(args[1] as string) };
      else schedule = { id: args[0], manager_user_id: owner, property_id: f.propertyId, record_type: "manager_property_availability", test_workspace_id: null, row_data: JSON.parse(args[3] as string) };
    }
    return { rows: [] };
  });
  return { query, sibling, createIdentity: () => { user = { id: owner, email: f.managerEmail, raw_app_meta_data: { e2eFixture: f.marker } }; }, state: () => ({ registry, schedule }) };
}
describe("dedicated public tour synthetic fixture", () => {
  it("requires exact DEV URL before any read or write, including dry run", async () => {
    const db = database();
    await expect(preparePublicTourFixture(db, { url: "https://xwszcafaontidfgznlxd.supabase.co" })).rejects.toThrow("exact DEV");
    expect(db.query).not.toHaveBeenCalled();
  });
  it("defaults to read-only dry run", async () => {
    const db = database();
    expect(await preparePublicTourFixture(db, { url })).toMatchObject({ applied: false, syntheticSeedOnly: true });
    expect(db.query.mock.calls.some(([sql]) => /^(insert|update|delete|LOCK)/.test(sql))).toBe(false);
  });
  it.each([{ foreignMarker: true }, { foreignOwner: true }])("refuses foreign identity/owner before mutations %j", async (options) => {
    const db = database(options);
    const authAdmin = { createUser: vi.fn() };
    await expect(preparePublicTourFixture(db, { url, apply: true, authAdmin, now })).rejects.toThrow("collision");
    expect(authAdmin.createUser).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => /^(insert|update|delete)/.test(sql))).toBe(false);
  });
  it("resumes marked Auth-only partial setup and reruns without creating an account", async () => {
    const db = database({ partial: true });
    const authAdmin = { createUser: vi.fn() };
    await preparePublicTourFixture(db, { url, apply: true, authAdmin, now });
    await preparePublicTourFixture(db, { url, apply: true, authAdmin, now });
    expect(authAdmin.createUser).not.toHaveBeenCalled();
    expect(db.state().registry.row_data.payload.sibling).toEqual(db.sibling);
    expect(db.query.mock.calls.filter(([sql]) => sql.startsWith("insert into public.profiles"))).toHaveLength(1);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("creates only the marked synthetic Auth account via admin, with no invite or password", async () => {
    const db = database({ partial: true, noIdentity: true });
    const authAdmin = { createUser: vi.fn(async () => { db.createIdentity(); return { data: { user: { id: owner } }, error: null }; }) };
    await preparePublicTourFixture(db, { url, apply: true, authAdmin, now });
    expect(authAdmin.createUser).toHaveBeenCalledExactlyOnceWith({ email: f.managerEmail, email_confirm: true, app_metadata: { e2eFixture: f.marker }, user_metadata: { role: "manager", full_name: "Synthetic Public Tour Manager" } });
  });
  it("serializes shared registry merge and preserves sibling and owned schedule data", async () => {
    const db = database();
    await preparePublicTourFixture(db, { url, apply: true, now });
    expect(db.query.mock.calls.findIndex(([sql]) => sql.startsWith("LOCK TABLE"))).toBeLessThan(db.query.mock.calls.findIndex(([sql]) => sql.includes("from auth.users")));
    expect(db.state().registry.row_data).toMatchObject({ retained: true, payload: { sibling: db.sibling } });
    expect(db.state().schedule?.row_data).toMatchObject({ retained: true, payload: expect.arrayContaining(["2026-11-09:22"]) });
  });
  it("uses current source shapes, named rooms, empty photos and future Pacific wall dates", () => {
    const shape = publicTourFixtureData(owner, now);
    expect(shape.slots[0]).toBe("2026-11-09:20");
    expect(shape.property.listingSubmission).toMatchObject({ v: 1, housePhotoDataUrls: [], rooms: [{ id: "qa-public-room-1", name: "Cedar room", photoDataUrls: [] }, { id: "qa-public-room-2", name: "Maple room", photoDataUrls: [] }] });
    expect(shape.property.imageUrl).toBe("");
    expect(() => mergePublicTourHosts({ payload: { [f.propertyId]: [{ userId: "foreign" }] } }, owner)).toThrow("collision");
  });
});
