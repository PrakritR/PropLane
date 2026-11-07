/** Bounded synthetic DEV setup. No signup, consent or delivery evidence. */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { connectNonproductionDatabase, nonproductionDatabaseConfig } from "../../scripts/security/nonproduction-database.mjs";
export const PUBLIC_TOUR_FIXTURE = Object.freeze({
  marker: "canonical-public-tours-v1", managerEmail: "public-tours-fixture@example.invalid",
  managerAxisId: "MGR-PUBLICTOURS", propertyId: "qa-public-tour-house",
  workspaceId: "a93fb321-9932-477b-8fe9-21208fd349a5", title: "Synthetic Public Tour House",
});
const f = PUBLIC_TOUR_FIXTURE;
const DEV = "https://emstjswhotsnyksqhqyf.supabase.co";
const REGISTRY = "axis_property_mgr_registry_v1";
const NAME = "Synthetic Public Tour Manager";
const WORKSPACE = `Public tours fixture (${f.marker})`;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
export function publicTourFixtureData(ownerId, now = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const day = new Date(`${date}T12:00:00Z`);
  const slots = [2, 3, 4].flatMap((offset) => {
    const next = new Date(day); next.setUTCDate(next.getUTCDate() + offset);
    return [20, 21, 28, 29].map((slot) => `${next.toISOString().slice(0, 10)}:${slot}`);
  });
  const rooms = ["Cedar", "Maple"].map((name, i) => ({ id: `qa-public-room-${i + 1}`, name: `${name} room`, floor: "1", monthlyRent: 1000 + i * 100,
    availability: "Now", moveInAvailableDate: date, manualUnavailableRanges: [], photoDataUrls: [], videoDataUrl: null, occupancyCapacity: 1 }));
  const property = { id: f.propertyId, title: f.title, buildingName: f.title, address: "100 Synthetic Fixture Lane, Seattle, WA 98101", zip: "98101",
    beds: 2, baths: 1, rentLabel: "$1,000 / mo", available: "Now", imageUrl: "", managerUserId: ownerId,
    buildingId: `${f.propertyId}-bld`, unitLabel: "2 rooms", adminPublishLive: true, e2eFixture: f.marker,
    listingSubmission: { v: 1, buildingName: f.title, address: "100 Synthetic Fixture Lane, Seattle, WA 98101", zip: "98101", listingPlaceCategoryId: "private_room",
      housePhotoDataUrls: [], allowedLeaseTerms: ["12 months"], rooms, bathrooms: [], sharedSpaces: [], bundles: [], quickFacts: [] } };
  return { property, slots, scheduleId: `axis_mgr_avail_slots_v2_${ownerId}_prop_${f.propertyId}` };
}
export function mergePublicTourHosts(rowData, ownerId) {
  if (rowData && (!object(rowData) || !object(rowData.payload))) throw new Error("Public tour registry shape collision.");
  const payload = rowData?.payload ?? {};
  const hosts = payload[f.propertyId];
  if (hosts && (!Array.isArray(hosts) || hosts.length !== 1 || hosts[0].userId !== ownerId || hosts[0].propertyId !== f.propertyId || hosts[0].e2eFixture !== f.marker)) throw new Error("Public tour host ownership collision.");
  return { ...(rowData ?? { id: REGISTRY, recordType: REGISTRY }), payload: { ...payload,
    [f.propertyId]: [{ userId: ownerId, label: NAME, propertyId: f.propertyId, e2eFixture: f.marker }] } };
}
async function inventory(db) {
  const users = await db.query("select id::text,email,raw_app_meta_data from auth.users where lower(email)=$1", [f.managerEmail]);
  if (users.rows.length > 1) throw new Error("Public tour Auth collision.");
  const user = users.rows[0];
  if (user && (user.email !== f.managerEmail || user.raw_app_meta_data?.e2eFixture !== f.marker)) throw new Error("Public tour Auth marker collision.");
  const profiles = await db.query(`select p.id::text,p.email,p.manager_id,p.role,p.full_name,
    (select coalesce(array_agg(role order by role),'{}') from public.profile_roles where user_id=p.id) roles
    from public.profiles p where p.email=$1 or p.manager_id=$2 or p.id=$3::uuid`, [f.managerEmail, f.managerAxisId, user?.id ?? null]);
  for (const row of profiles.rows) {
    if (!user || row.id !== user.id || row.email !== f.managerEmail || row.manager_id !== f.managerAxisId || row.role !== "manager" || row.full_name !== NAME || row.roles.some((role) => role !== "manager")) throw new Error("Public tour profile/role collision.");
  }
  const workspaces = await db.query("select id::text,owner_user_id::text,name,is_default,is_service from public.portal_workspaces where id=$1::uuid or owner_user_id=$2::uuid", [f.workspaceId, user?.id ?? null]);
  if (workspaces.rows.some((row) => !user || row.id !== f.workspaceId || row.owner_user_id !== user.id || row.name !== WORKSPACE || !row.is_default || row.is_service)) throw new Error("Public tour workspace collision.");
  const properties = await db.query("select * from public.manager_property_records where id=$1 or manager_user_id=$2::uuid", [f.propertyId, user?.id ?? null]);
  if (properties.rows.some((row) => !user || row.id !== f.propertyId || row.manager_user_id !== user.id || row.workspace_id !== f.workspaceId || row.test_workspace_id !== null || row.property_data?.e2eFixture !== f.marker || row.row_data?.e2eFixture !== f.marker)) throw new Error("Public tour property collision.");
  const scheduleId = user ? publicTourFixtureData(user.id).scheduleId : "__public-tour-no-owner__";
  const schedules = await db.query("select * from public.portal_schedule_records where id=$1 or manager_user_id=$2::uuid or property_id=$3", [scheduleId, user?.id ?? null, f.propertyId]);
  if (schedules.rows.some((row) => !user || row.id !== scheduleId || row.manager_user_id !== user.id || row.property_id !== f.propertyId || row.record_type !== "manager_property_availability" || row.test_workspace_id !== null || row.row_data?.e2eFixture !== f.marker || !Array.isArray(row.row_data?.payload))) throw new Error("Public tour availability collision.");
  const registry = await db.query("select * from public.portal_schedule_records where id=$1", [REGISTRY]);
  const registryRow = registry.rows[0];
  if (registryRow && (registryRow.record_type !== REGISTRY || registryRow.test_workspace_id !== null)) throw new Error("Public tour registry collision.");
  // An entry before the marked identity exists is never ours to take over.
  if (!user && registryRow?.row_data?.payload?.[f.propertyId]) throw new Error("Public tour host collision.");
  mergePublicTourHosts(registryRow?.row_data, user?.id);
  return { user, profile: profiles.rows[0], workspace: workspaces.rows[0], property: properties.rows[0], schedule: schedules.rows[0], registry: registryRow };
}
export async function preparePublicTourFixture(db, { url, apply = false, authAdmin, now = new Date() } = {}) {
  if (url !== DEV) throw new Error("Public tour fixture requires exact DEV URL.");
  try {
    await db.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    await db.query("SET LOCAL ROLE postgres");
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
    if (apply) {
      await db.query("select pg_advisory_xact_lock(hashtext($1))", [f.marker]);
      // Serialize singleton merging, including its initially absent case.
      await db.query("LOCK TABLE public.portal_schedule_records IN SHARE ROW EXCLUSIVE MODE");
    }
    let state = await inventory(db);
    if (!apply) {
      await db.query("ROLLBACK");
      return { applied: false, fixture: f.marker, existingIdentity: Boolean(state.user), syntheticSeedOnly: true };
    }
    if (!state.user) {
      if (!authAdmin) throw new Error("DEV Auth admin required.");
      const { data, error } = await authAdmin.createUser({ email: f.managerEmail, email_confirm: true,
        app_metadata: { e2eFixture: f.marker }, user_metadata: { role: "manager", full_name: NAME } });
      if (error || !data?.user?.id) throw new Error("Public tour marked Auth creation failed.");
      state = await inventory(db);
      if (state.user?.id !== data.user.id) throw new Error("Public tour Auth readback failed.");
    }
    const owner = state.user.id;
    if (!state.profile) await db.query("insert into public.profiles(id,email,role,manager_id,full_name) values($1::uuid,$2,'manager',$3,$4)", [owner, f.managerEmail, f.managerAxisId, NAME]);
    await db.query("insert into public.profile_roles(user_id,role) values($1::uuid,'manager') on conflict(user_id,role) do nothing", [owner]);
    if (!state.workspace) await db.query("insert into public.portal_workspaces(id,owner_user_id,name,is_default,is_service) values($1::uuid,$2::uuid,$3,true,false)", [f.workspaceId, owner, WORKSPACE]);
    const { property, slots, scheduleId } = publicTourFixtureData(owner, now);
    await db.query(`insert into public.manager_property_records(id,manager_user_id,workspace_id,status,property_data,row_data)
      values($1,$2::uuid,$3::uuid,'live',$4::jsonb,$5::jsonb) on conflict(id) do update set status='live',property_data=excluded.property_data,row_data=excluded.row_data,updated_at=now()`,
    [f.propertyId, owner, f.workspaceId, JSON.stringify(property), JSON.stringify({ id: f.propertyId, status: "live", name: f.title, e2eFixture: f.marker })]);
    // Preserve all already-owned availability and add only the upcoming fixture window.
    const payload = [...new Set([...(state.schedule?.row_data?.payload ?? []), ...slots])];
    await db.query(`insert into public.portal_schedule_records(id,manager_user_id,property_id,record_type,row_data)
      values($1,$2::uuid,$3,'manager_property_availability',$4::jsonb) on conflict(id) do update set row_data=excluded.row_data,updated_at=now()`,
    [scheduleId, owner, f.propertyId, JSON.stringify({ ...(state.schedule?.row_data ?? {}), id: scheduleId, recordType: "manager_property_availability", managerUserId: owner, propertyId: f.propertyId, e2eFixture: f.marker, payload })]);
    await db.query(`insert into public.portal_schedule_records(id,manager_user_id,record_type,row_data) values($1,null,$1,$2::jsonb)
      on conflict(id) do update set row_data=excluded.row_data,updated_at=now()`, [REGISTRY, JSON.stringify(mergePublicTourHosts(state.registry?.row_data, owner))]);
    const proof = await inventory(db);
    const rooms = proof.property?.property_data?.listingSubmission?.rooms;
    if (proof.profile?.roles.join(",") !== "manager" || !proof.workspace || proof.property?.status !== "live" || rooms?.length !== 2 || rooms.some((room) => !room.id || !room.name) || !slots.every((slot) => proof.schedule?.row_data.payload.includes(slot)) || !proof.registry?.row_data?.payload?.[f.propertyId]?.some((host) => host.userId === owner)) throw new Error("Public tour fixture final readback failed.");
    await db.query("COMMIT");
    return { applied: true, fixture: f.marker, propertyId: f.propertyId, futureSlots: slots.length, syntheticSeedOnly: true };
  } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
}
export async function runPublicTourPreparation(args = process.argv.slice(2)) {
  if (args.some((arg) => !["--public-tour-fixture", "--apply"].includes(arg))) throw new Error("Unsupported public tour fixture argument.");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (url !== DEV) throw new Error("Exact DEV URL required.");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("DEV service role key required.");
  const db = await connectNonproductionDatabase(nonproductionDatabaseConfig("emstjswhotsnyksqhqyf"));
  try {
    const authAdmin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;
    const result = await preparePublicTourFixture(db, { url, apply: args.includes("--apply"), authAdmin });
    console.log(JSON.stringify(result)); return result;
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runPublicTourPreparation().catch(() => { console.error("Public tour synthetic fixture preparation failed."); process.exitCode = 1; });
