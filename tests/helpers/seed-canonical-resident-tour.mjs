/** Minimal existing-actor DEV tour and two-sided conversation fixture. Never delivers a message. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { connectNonproductionDatabase, nonproductionDatabaseConfig } from "../../scripts/security/nonproduction-database.mjs";
export const CANONICAL_RESIDENT_TOUR = Object.freeze({
  marker: "canonical-resident-tour-v1", inquiryId: "qa-canonical-resident-tour-v1",
  propertyId: "mgr-test-magnolia", residentEmail: "resident@test.proplane.local", managerEmail: "manager2@test.proplane.local",
  managerThreadId: "qa-canonical-resident-tour-v1:manager", residentThreadId: "qa-canonical-resident-tour-v1:resident",
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SINGLETON = "axis_admin_partner_inquiries_v1";
const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";
export function canonicalTourThreads({ manager, resident, workspaceId, propertyTitle, now = new Date() }) {
  const f = CANONICAL_RESIDENT_TOUR;
  const stamp = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const body = "Can we discuss the tour for Magnolia House?";
  return ["manager", "resident"].map((side) => {
    const isManager = side === "manager";
    const id = isManager ? f.managerThreadId : f.residentThreadId;
    const scope = isManager ? MANAGER_SCOPE : RESIDENT_SCOPE;
    const key = isManager ? `acct:${resident.id}` : `ws:${workspaceId}`;
    return { id, scope, ownerUserId: isManager ? manager.id : resident.id, participantEmail: f.residentEmail,
      conversationKey: key, workspaceId,
      rowData: { id, scope, folder: "inbox", from: isManager ? resident.name : `Property manager (${propertyTitle})`,
        email: isManager ? f.residentEmail : f.managerEmail, subject: "Magnolia tour fixture", body, preview: body,
        time: stamp, unread: false, propertyId: f.propertyId, propertyTitle, managerUserId: manager.id,
        counterpartyRole: isManager ? "resident" : "manager", rootHouseId: f.propertyId, rootHouseLabel: propertyTitle,
        workspaceId, conversationKey: key, e2eFixture: f.marker, ...(isManager ? {} : { rootOutbound: true }),
        messages: [{ id: `${id}:turn`, from: manager.name, body: "Yes, we can review the Magnolia tour details here.", at: stamp, time: stamp, outbound: isManager, houseId: f.propertyId, houseLabel: propertyTitle }] } };
  });
}
export async function prepareCanonicalResidentTour(db, { url, apply = false, expectedIds, env = process.env }) {
  const f = CANONICAL_RESIDENT_TOUR;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co") throw new Error("Resident tour fixture requires exact DEV URL.");
  for (const [key, email] of [["E2E_MANAGER2_EMAIL", f.managerEmail], ["E2E_RESIDENT_EMAIL", f.residentEmail]]) {
    if (env[key]?.trim() && env[key].trim().toLowerCase() !== email) throw new Error("Resident tour fixture refuses account overrides.");
  }
  if (apply && (!expectedIds || !["manager2", "resident", "workspaceId"].every((key) => UUID.test(expectedIds[key] ?? "")))) throw new Error("Apply requires reviewed existing actor/workspace IDs.");
  try {
    await db.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN READ ONLY");
    await db.query("SET LOCAL ROLE postgres");
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query("SET LOCAL lock_timeout='5s'");
    const people = await db.query(`select p.id::text,p.email,p.manager_id,p.full_name,
      (select array_agg(role order by role) from public.profile_roles where user_id=p.id) roles
      from public.profiles p join auth.users u on u.id=p.id and u.email=p.email where p.email=any($1::text[])`, [[f.managerEmail, f.residentEmail]]);
    const manager = people.rows.find((row) => row.email === f.managerEmail);
    const resident = people.rows.find((row) => row.email === f.residentEmail);
    // Existing canonical resident identity from the 2026-11-07 DEV audit; never reset the profile.
    if (people.rows.length !== 2 || manager?.manager_id !== "MGR-TESTE2E2" || resident?.manager_id !== "PROPLANE-3C022893" ||
      JSON.stringify(manager.roles) !== '["manager"]' || JSON.stringify(resident.roles) !== '["resident"]' ||
      (expectedIds && (manager.id !== expectedIds.manager2 || resident.id !== expectedIds.resident))) throw new Error("Canonical existing tour actor mismatch.");
    const property = await db.query(`select p.id,p.manager_user_id::text,p.workspace_id::text,p.property_data,
      w.owner_user_id::text,w.is_default,w.is_service from public.manager_property_records p
      join public.portal_workspaces w on w.id=p.workspace_id where p.id=$1`, [f.propertyId]);
    const house = property.rows[0];
    if (property.rows.length !== 1 || house.manager_user_id !== manager.id || house.owner_user_id !== manager.id || !house.is_default || house.is_service ||
      (expectedIds && house.workspace_id !== expectedIds.workspaceId)) throw new Error("Canonical resident tour property/workspace mismatch.");
    const service = await db.query("select id from public.portal_workspaces where owner_user_id=$1 and is_service", [manager.id]);
    if (service.rows.length) throw new Error("Resident tour software manager must not own a service workspace.");
    const propertyTitle = house.property_data?.title || house.property_data?.buildingName;
    if (typeof propertyTitle !== "string" || !propertyTitle.includes("Magnolia")) throw new Error("Canonical tour property title mismatch.");
    const record = await db.query(`select row_data from public.portal_schedule_records where id=$1${apply ? " for update" : ""}`, [SINGLETON]);
    const original = record.rows[0]?.row_data;
    if (record.rows.length !== 1 || !original || !Array.isArray(original.payload)) throw new Error("Canonical inquiry singleton unavailable.");
    const matching = original.payload.filter((row) => row.id === f.inquiryId);
    if (matching.length > 1 || matching.some((row) => row.e2eFixture !== f.marker || row.email !== f.residentEmail || row.propertyId !== f.propertyId || row.managerUserId !== manager.id || row.kind !== "tour")) throw new Error("Canonical inquiry namespace conflict.");
    const links = await db.query("select * from public.resident_tour_links where inquiry_id=$1", [f.inquiryId]);
    if (links.rows.length > 1 || links.rows.some((row) => row.resident_user_id !== resident.id || row.manager_user_id !== manager.id || row.property_id !== f.propertyId || row.attendee_email !== f.residentEmail)) throw new Error("Canonical tour link conflict.");
    const threads = canonicalTourThreads({ manager: { id: manager.id, name: manager.full_name || "Test Manager 2" }, resident: { id: resident.id, name: resident.full_name || "Test Resident" }, workspaceId: house.workspace_id, propertyTitle });
    const current = await db.query(`select id,owner_user_id::text,scope,row_data,workspace_id::text,conversation_key from public.portal_inbox_thread_records
      where id=any($1::text[]) or (scope=$2 and owner_user_id=$3::uuid and (participant_email=$5 or row_data->>'email'=$5))
      or (scope=$4 and owner_user_id=$6::uuid and row_data->>'email'=$7)`, [[f.managerThreadId, f.residentThreadId], MANAGER_SCOPE, manager.id, RESIDENT_SCOPE, f.residentEmail, resident.id, f.managerEmail]);
    for (const row of current.rows) {
      const expected = threads.find((thread) => thread.id === row.id);
      if (!expected || row.owner_user_id !== expected.ownerUserId || row.scope !== expected.scope || row.workspace_id !== expected.workspaceId || row.conversation_key !== expected.conversationKey || row.row_data?.e2eFixture !== f.marker || row.row_data?.propertyId !== f.propertyId || row.row_data?.managerUserId !== manager.id || !row.row_data?.messages?.length) throw new Error("Existing conversation conflicts with the bounded tour fixture.");
    }
    if (apply) {
      if (!matching.length) {
        const inquiry = { id: f.inquiryId, e2eFixture: f.marker, kind: "tour", status: "pending", name: resident.full_name || "Test Resident",
          email: f.residentEmail, propertyId: f.propertyId, propertyTitle, managerUserId: manager.id,
          createdAt: new Date().toISOString(), tourFormat: "in_person", smsConsent: false, smsOrigin: "non_sms", noticeChannel: "portal", requestedWindows: [] };
        await db.query("update public.portal_schedule_records set row_data=$2::jsonb,updated_at=now() where id=$1", [SINGLETON, JSON.stringify({ ...original, payload: [...original.payload, inquiry] })]);
      }
      if (!links.rows.length) {
        const bound = await db.query("select public.bind_resident_tour_link($1::uuid,$2,null,$3::uuid,$4,$5) as bound", [resident.id, f.inquiryId, manager.id, f.propertyId, f.residentEmail]);
        if (bound.rows[0]?.bound !== true) throw new Error("Canonical resident tour binding refused.");
      }
      for (const thread of threads) {
        if (current.rows.some((row) => row.id === thread.id)) continue;
        await db.query(`insert into public.portal_inbox_thread_records(id,scope,owner_user_id,participant_email,thread_type,workspace_id,conversation_key,row_data,updated_at)
          values($1,$2,$3::uuid,$4,'portal_message',$5::uuid,$6,$7::jsonb,now())`, [thread.id, thread.scope, thread.ownerUserId, thread.participantEmail, thread.workspaceId, thread.conversationKey, JSON.stringify(thread.rowData)]);
      }
      const proof = await db.query(`select (select count(*)::int from public.resident_tour_links where inquiry_id=$1 and resident_user_id=$2::uuid and manager_user_id=$3::uuid and property_id=$4) links,
        (select count(*)::int from public.portal_inbox_thread_records where id=any($5::text[]) and row_data->>'e2eFixture'=$6) threads`, [f.inquiryId, resident.id, manager.id, f.propertyId, threads.map((t) => t.id), f.marker]);
      if (proof.rows[0]?.links !== 1 || proof.rows[0]?.threads !== 2) throw new Error("Canonical tour fixture readback failed.");
      await db.query("COMMIT");
    } else await db.query("ROLLBACK");
    return { applied: apply, fixture: f.marker, existingInquiry: matching.length === 1, existingLink: links.rows.length === 1, existingThreads: current.rows.length, syntheticSeedOnly: true };
  } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
}
export async function runCanonicalResidentTourPreparation(args = process.argv.slice(2)) {
  const fileIndex = args.indexOf("--expected-ids-file");
  if (args.some((arg, i) => !["--resident-tour-prerequisite", "--apply", "--expected-ids-file"].includes(arg) && !(fileIndex >= 0 && i === fileIndex + 1))) throw new Error("Unsupported resident tour fixture argument.");
  const expectedIds = fileIndex >= 0 ? JSON.parse(readFileSync(args[fileIndex + 1], "utf8")) : undefined;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co") throw new Error("Exact DEV URL required.");
  const db = await connectNonproductionDatabase(nonproductionDatabaseConfig("emstjswhotsnyksqhqyf"));
  try { console.log(JSON.stringify(await prepareCanonicalResidentTour(db, { url, apply: args.includes("--apply"), expectedIds }))); }
  finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCanonicalResidentTourPreparation().catch(() => { console.error("Canonical resident tour setup failed; inspect reviewed inventory."); process.exitCode = 1; });
