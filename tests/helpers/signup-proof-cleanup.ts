/** Bounded disposable-actor adapter around the canonical role purgers. DEV only. */
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { readdirSync, lstatSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { purgeManagerPortalData, purgeResidentPortalData } from "@/lib/auth/purge-portal-account-data";
import { applicationPhotoFolderKey } from "@/lib/rental-application/application-photo-folder";
import { readSignupJournal, persistSignupJournal, identifySignupActor, type SignupJournal } from "./signup-proof-journal";
import { assertCleanupSignupActor } from "./signup-proof-cleanup-identity";
import { inspectSignupPurgeCandidates, classifySignupCandidate, assertSignupApplicationResidentSubject } from "./signup-proof-candidates";
import { inspectSignupPhoneState } from "./signup-proof-phone-cleanup";
import { proveSignupShutdown, verifySignupPortClosed } from "./signup-proof-shutdown";

type Row = Record<string, unknown>;
type Reservation = { file: string; manifest: SignupJournal };
type Observer = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>; end(): Promise<unknown> };
export type CleanupDependencies = { db: SupabaseClient; observer: Observer; residentPurge?: typeof purgeResidentPortalData; managerPurge?: typeof purgeManagerPortalData };
const DEV = "https://emstjswhotsnyksqhqyf.supabase.co";
function fail(): never { throw new Error("Signup fixture cleanup refused."); }
const emailLiteral = (s: string) => s.replace(/[\\%_]/g, "\\$&");
export async function cleanupRows(query: PromiseLike<{ data: unknown; error: unknown; count?: number | null }>, requireCount = false): Promise<Row[]> {
  let result;
  try { result = await query; } catch { return fail(); }
  if (result.error || !Array.isArray(result.data) || result.data.length > 100 || requireCount && (!Number.isSafeInteger(result.count) || result.count !== result.data.length)) fail();
  return result.data as Row[];
}
const read = (db: SupabaseClient, table: string, column: string, value: unknown, email = false) => cleanupRows((email ? db.from(table).select("*", { count: "exact" }).ilike(column, emailLiteral(String(value))) : db.from(table).select("*", { count: "exact" }).eq(column, value)).limit(101), true);
async function zero(db: SupabaseClient, table: string, column: string, value: unknown, email = false) { if ((await read(db, table, column, value, email)).length) fail(); }
const phaseOrder = ["reserved", "registered", "phone-bound", "cleanup-started", "portal-purged", "auth-delete-started", "complete"];
function advance(r: Reservation, phase: NonNullable<SignupJournal["phase"]>) { if (phaseOrder.indexOf(phase) > phaseOrder.indexOf(r.manifest.phase ?? "reserved")) { r.manifest.phase = phase; persistSignupJournal(r.file, r.manifest); } }
function pairOf(r: Reservation, reservations: Reservation[]): Reservation | undefined {
  const m = r.manifest;
  if (!m.pairedActorId) return undefined;
  const pair = reservations.filter((item) => item.manifest.actorId === m.pairedActorId && item.manifest.nonce === m.pairedNonce);
  if (pair.length !== 1 || pair[0]!.manifest.pairedActorId !== m.actorId || pair[0]!.manifest.pairedNonce !== m.nonce || pair[0]!.manifest.tier === m.tier) fail();
  return pair[0];
}
async function authUser(db: SupabaseClient, r: Reservation): Promise<User | null> {
  const m = r.manifest;
  if (!m.actorId) await identifySignupActor(db, r);
  if (!m.actorId) return null;
  const result = await db.auth.admin.getUserById(m.actorId);
  if (result.error) {
    if ((result.error.status === 404 || result.error.code === "user_not_found") && ["auth-delete-started", "complete"].includes(m.phase ?? "")) return null;
    fail();
  }
  assertCleanupSignupActor(m, result.data.user);
  if (!m.actorCreatedAt || result.data.user?.created_at !== m.actorCreatedAt) fail();
  if (Date.parse(result.data.user!.created_at) > Date.now()) fail();
  if (m.phoneBound && (!result.data.user?.phone_confirmed_at || !Number.isFinite(Date.parse(result.data.user.phone_confirmed_at)) || Date.parse(result.data.user.phone_confirmed_at) < Date.parse(m.startedAt) || Date.parse(result.data.user.phone_confirmed_at) > Date.now() || result.data.user.phone?.replace(/\D/g, "") !== m.phone.slice(1))) fail();
  return result.data.user;
}
async function sessionsAbsent(observer: Observer, m: SignupJournal) {
  if (!m.actorId) return;
  const result = await observer.query("select * from signup_fixture_guard.session_counts($1::uuid)", [m.actorId]);
  if (result.rows.length !== 1 || result.rows[0]?.project_ref !== "emstjswhotsnyksqhqyf" || Number(result.rows[0]?.sessions) !== 0 || Number(result.rows[0]?.refresh_tokens) !== 0) fail();
}
async function emptyStorage(db: SupabaseClient, bucket: string, prefix: string): Promise<void> {
  if (prefix.split("/").some((part) => !part || part === "." || part === "..")) fail();
  const result = await db.storage.from(bucket).list(prefix, { limit: 1, offset: 0, sortBy: { column: "name", order: "asc" } });
  if (result.error || !Array.isArray(result.data) || result.data.length) fail();
}
async function inspectPhone(db: SupabaseClient, m: SignupJournal) {
  if (!m.actorId) return [];
  const contacts = await read(db, "sms_phone_contacts", "phone_e164", m.phone);
  const challenges = await read(db, "phone_otp_challenges", "auth_user_id", m.actorId);
  const locks = [...await read(db, "phone_auth_operation_locks", "key", `phone:${m.phone}`), ...await read(db, "phone_auth_operation_locks", "key", `user:${m.actorId}`)];
  inspectSignupPhoneState(m, { contacts: contacts as never[], challenges: challenges as never[], locks: locks as never[] });
  if (challenges.some((row) => row.auth_provider !== "local")) fail();
  const owners = await db.rpc("phone_auth_owners", { p_phone: m.phone });
  if (owners.error || !Array.isArray(owners.data) || owners.data.some((id) => id !== m.actorId)) fail();
  // Profile aliases cannot reserve the fixture number for another person.
  for (let offset = 0; offset < 100000; offset += 100) {
    const result = await db.from("profiles").select("id,phone", { count: "exact" }).order("id").range(offset, offset + 99);
    if (result.error || !Array.isArray(result.data) || !Number.isSafeInteger(result.count) || result.data.length < Math.min(100, result.count! - offset)) fail();
    if (result.data.some((row) => row.id !== m.actorId && [m.phone.slice(1), m.phone.slice(2)].includes(String(row.phone ?? "").replace(/\D/g, "")))) fail();
    if (offset + result.data.length >= result.count!) break;
    if (offset === 99900) fail();
  }
  return contacts;
}
async function reconcileInventory(db: SupabaseClient, r: Reservation, paired?: Reservation) {
  const m = r.manifest;
  if (m.tier !== "pro" || !m.actorId || ["portal-purged", "auth-delete-started", "complete"].includes(m.phase ?? "")) return;
  const properties = await read(db, "manager_property_records", "manager_user_id", m.actorId);
  const property = m.inventory?.find((entry) => entry.namespace === "property");
  if (properties.length > 1 || properties.length && (!property || !JSON.stringify([properties[0]!.row_data, properties[0]!.property_data]).includes(m.nonce))) fail();
  if (property?.state === "resolved" && (properties.length && properties[0]!.id !== property.id || !properties.length && phaseOrder.indexOf(m.phase ?? "reserved") < phaseOrder.indexOf("cleanup-started"))) fail();
  if (property?.state === "unresolved" && properties.length) { property.id = String(properties[0]!.id); property.state = "resolved"; }
  if (property?.state === "unresolved" && !properties.length) {
    // The intent never produced a row. Preserve a proved zero state in the same exact namespace.
    property.state = "absent";
  }
  const listing = m.inventory?.find((entry) => entry.namespace === "listing");
  if (listing && property?.state === "absent") listing.state = "absent";
  if (listing && property?.id) { listing.id = property.id; listing.state = "resolved"; }
  const applications = await read(db, "manager_application_records", "manager_user_id", m.actorId);
  const application = m.inventory?.find((entry) => entry.namespace === "application");
  if (applications.length > 1 || applications.length && (!application || !paired?.manifest.actorId || applications[0]!.resident_email !== paired.manifest.email || applications[0]!.property_id !== property?.id && applications[0]!.assigned_property_id !== property?.id)) fail();
  for (const row of applications) assertSignupApplicationResidentSubject(row, m, paired?.manifest, application);
  if (application?.state === "resolved" && (applications.length && applications[0]!.id !== application.id || !applications.length && phaseOrder.indexOf(m.phase ?? "reserved") < phaseOrder.indexOf("cleanup-started") && phaseOrder.indexOf(paired?.manifest.phase ?? "reserved") < phaseOrder.indexOf("portal-purged"))) fail();
  if (application?.state === "unresolved" && applications.length) { application.id = String(applications[0]!.id); application.state = "resolved"; }
  if (application?.state === "unresolved" && !applications.length) application.state = "absent";
  const threads = m.inventory?.find((entry) => entry.namespace === "resident-threads");
  const threadRows = [...await read(db, "portal_inbox_thread_records", "owner_user_id", m.actorId), ...(paired?.manifest.actorId ? await read(db, "portal_inbox_thread_records", "owner_user_id", paired.manifest.actorId) : [])];
  if (threadRows.length && !threads) fail();
  if (threads?.state === "unresolved") {
    for (const row of threadRows) if (!["axis_portal_inbox_manager_v1", "axis_portal_inbox_resident_v1"].includes(String(row.scope)) || row.participant_email != null && ![m.email, paired?.manifest.email].includes(String(row.participant_email))) fail();
    threads.ids = [...new Set(threadRows.map((row) => String(row.id)))].sort(); threads.state = "resolved";
  }
  if (threads?.state === "resolved" && threadRows.some((row) => !threads.ids?.includes(String(row.id)))) fail();
  persistSignupJournal(r.file, m);
}
/** Includes canonical inline side effects that are deliberately outside the manifest. */
async function inspectInline(db: SupabaseClient, r: Reservation, paired?: Reservation) {
  const m = r.manifest;
  if (!m.actorId) return;
  for (const [table, column] of [["number_subscriptions", "owner_user_id"], ["number_credit_accounts", "owner_user_id"], ["number_credit_usage_events", "owner_user_id"], ["number_credit_purchases", "owner_user_id"], ["number_credit_adjustments", "owner_user_id"], ["resident_agent_numbers", "resident_user_id"], ["vendor_work_identities", "vendor_user_id"], ["vendor_work_identity_release_queue", "vendor_user_id"], ["account_link_invites", "inviter_user_id"], ["account_link_invites", "invitee_user_id"], ["test_workspace_members", "user_id"], ["test_workspaces", "created_by_user_id"]]) await zero(db, table!, column!, m.actorId);
  for (const column of ["resident_user_id", "resident_email", "manager_user_id"]) {
    if (column === "manager_user_id" && m.tier !== "pro") continue;
    for (const table of ["resident_inspections", "resident_move_in_forms"]) await zero(db, table, column, column === "resident_email" ? m.email : m.actorId, column === "resident_email");
  }
  if (m.tier === "pro") {
    await zero(db, "manager_documents", "manager_user_id", m.actorId);
    await zero(db, "portal_pro_relationship_records", "related_user_id", m.actorId);
    const profiles = await read(db, "profiles", "id", m.actorId);
    const axis = m.managerAxisId ?? String(profiles[0]?.manager_id ?? "").trim().toUpperCase();
    if (axis) {
      const peers = await read(db, "profiles", "manager_id", axis, true);
      if (peers.length !== (profiles.length ? 1 : 0) || peers.some((row) => row.id !== m.actorId)) fail();
      await zero(db, "portal_pro_relationship_records", "row_data->>linkedAxisId", axis.toLowerCase());
      for (const purchase of await read(db, "manager_purchases", "manager_id", axis)) if (purchase.user_id !== m.actorId || purchase.email !== m.email) fail();
      for (const purchase of await read(db, "manager_purchases", "user_id", m.actorId)) if (purchase.manager_id !== axis) fail();
    } else if (m.registered && !["portal-purged", "auth-delete-started", "complete"].includes(m.phase ?? "")) fail();
  }
  if (m.tier === "resident") {
    for (const table of ["portal_recurring_rent_profile_records", "portal_resident_lease_upload_records"]) await zero(db, table, "row_data->>residentEmail", m.email, true);
    for (const [column, value] of [["senderUserId", m.actorId], ["recipientUserId", m.actorId], ["senderEmail", m.email], ["recipientEmail", m.email]]) await zero(db, "portal_scheduled_inbox_message_records", `row_data->>${column}`, value, column!.endsWith("Email"));
    for (const column of ["row_data->>email", "row_data->>fromEmail"]) for (const row of await read(db, "portal_inbox_thread_records", column, m.email, true)) await classifySignupCandidate("portal_inbox_thread_records", row, m, paired?.manifest, db);
    const apps = await read(db, "manager_application_records", "resident_email", m.email, true);
    for (const row of apps) {
      await classifySignupCandidate("manager_application_records", row, m, paired?.manifest, db);
      await zero(db, "screening_orders", "application_id", row.id);
      await zero(db, "cosigner_submission_records", "signer_app_id", row.id);
    }
  }
  const manager = m.tier === "pro" ? m : paired?.manifest;
  for (const entry of manager?.inventory ?? []) if (entry.namespace === "application" && entry.id) await emptyStorage(db, "application-documents", `application/${applicationPhotoFolderKey(entry.id)}`);
  for (const [bucket, prefix] of [["manager-documents", `manager/${m.actorId}`], ["listing-photos", m.actorId], ["lease-templates", m.actorId], ["inspection-evidence", m.actorId], ["sms-media", `manager/${m.actorId}`], ["portal-inbox-attachments", m.actorId], ["bug-feedback-attachments", `bug-feedback/${m.actorId}`]]) await emptyStorage(db, bucket!, prefix!);
}
/** Discover public FK side effects from pg_catalog, which is not privilege-filtered. */
async function inspectCatalog(deps: CleanupDependencies, reservations: Reservation[], users: Map<string, User>) {
  const result = await deps.observer.query(`select pn.nspname parent_schema,p.relname parent_table,cn.nspname child_schema,c.relname child_table,k.confdeltype,
    array(select a.attname from unnest(k.confkey) with ordinality z(num,ord) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=z.num order by z.ord) parent_columns,
    array(select a.attname from unnest(k.conkey) with ordinality z(num,ord) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=z.num order by z.ord) child_columns
    from pg_constraint k join pg_class p on p.oid=k.confrelid join pg_namespace pn on pn.oid=p.relnamespace
    join pg_class c on c.oid=k.conrelid join pg_namespace cn on cn.oid=c.relnamespace where k.contype='f' and pn.nspname in ('auth','public') and cn.nspname='public'`);
  if (result.rows.length > 5000 || !result.rows.some((row) => row.parent_schema === "auth" && row.parent_table === "users" && row.child_table === "profiles" && row.confdeltype === "c")) fail();
  const queue: Array<{ schema: string; table: string; row: Row; depth: number }> = [];
  for (const r of reservations) if (r.manifest.actorId && users.has(r.manifest.actorId)) queue.push({ schema: "auth", table: "users", row: { id: r.manifest.actorId }, depth: 0 });
  for (const r of reservations) if (r.manifest.actorId) {
    const roots = await inspectSignupPurgeCandidates({ db: deps.db, journal: r.manifest, paired: pairOf(r, reservations)?.manifest, optionalTableAbsent: (table) => optionalAbsent(deps.observer, table) });
    for (const root of roots) queue.push({ schema: "public", ...root, depth: 0 });
  }
  let queries = 0;
  const visited = new Set<string>();
  for (let at = 0; at < queue.length; at++) {
    if (queue.length > 1000) fail();
    const root = queue[at]!;
    if (root.depth > 20) fail();
    const key = JSON.stringify([root.schema, root.table, root.row]);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const fk of result.rows.filter((row) => row.parent_schema === root.schema && row.parent_table === root.table)) {
      if (!Array.isArray(fk.parent_columns) || !Array.isArray(fk.child_columns) || !fk.parent_columns.length || fk.parent_columns.length !== fk.child_columns.length || typeof fk.child_table !== "string" || !/^[a-z_][a-z0-9_]*$/.test(fk.child_table)) fail();
      if (fk.parent_columns.some((column) => root.row[String(column)] === null)) continue;
      if (++queries > 5000 || !["a", "r", "c", "n", "d"].includes(String(fk.confdeltype))) fail();
      let query = deps.db.from(fk.child_table).select("*", { count: "exact" });
      for (let i = 0; i < fk.parent_columns.length; i++) {
        const parent = String(fk.parent_columns[i]), child = String(fk.child_columns[i]);
        if (!/^[a-z_][a-z0-9_]*$/.test(parent) || !/^[a-z_][a-z0-9_]*$/.test(child) || root.row[parent] === undefined) fail();
        query = query.eq(child, root.row[parent]);
      }
      const rows = await cleanupRows(query.limit(101), true);
      for (const row of rows) {
        if (fk.child_table === "profiles") {
          const actor = reservations.find((r) => r.manifest.actorId === row.id);
          if (!actor || row.email !== actor.manifest.email) fail();
        } else if (fk.child_table === "profile_roles") {
          const actor = reservations.find((r) => r.manifest.actorId === row.user_id);
          if (!actor || row.role !== (actor.manifest.tier === "pro" ? "manager" : "resident")) fail();
        } else if (fk.child_table === "phone_otp_challenges") {
          const actor = reservations.find((r) => r.manifest.actorId === row.auth_user_id);
          if (!actor || row.phone_e164 !== actor.manifest.phone || row.auth_provider !== "local" || row.purpose !== "sign_in") fail();
        } else if (fk.child_table === "sms_phone_contacts") {
          const actor = reservations.find((r) => r.manifest.actorId === row.user_id);
          if (!actor || row.phone_e164 !== actor.manifest.phone) fail();
        } else {
          let accepted = false;
          for (const r of reservations) {
            try { await classifySignupCandidate(fk.child_table, row, r.manifest, pairOf(r, reservations)?.manifest, deps.db); accepted = true; break; } catch { /* other exact pair actor may own the row */ }
          }
          if (!accepted) fail();
        }
        queue.push({ schema: "public", table: fk.child_table, row, depth: root.depth + 1 });
      }
    }
  }
}
async function inspectIdentity(db: SupabaseClient, r: Reservation, user: User | null) {
  const m = r.manifest;
  const profiles = await read(db, "profiles", "email", m.email, true);
  if (!user) { if (profiles.length) fail(); return; }
  if (profiles.length > 1 || profiles.length && profiles[0]!.id !== m.actorId || m.registered && profiles.length !== 1) fail();
  if (m.tier === "pro" && profiles[0]?.manager_id) {
    const axis = String(profiles[0].manager_id).trim().toUpperCase();
    if (m.managerAxisId && m.managerAxisId !== axis) fail();
    if (!m.managerAxisId) { m.managerAxisId = axis; persistSignupJournal(r.file, m); }
  }
  if (m.registered && (profiles[0]?.full_name !== m.fullName || profiles[0]?.phone !== m.phone)) fail();
  if (m.phoneBound && (!profiles[0]?.phone_verified_at || !Number.isFinite(Date.parse(String(profiles[0].phone_verified_at))) || Date.parse(String(profiles[0].phone_verified_at)) < Date.parse(m.startedAt))) fail();
  const roles = await read(db, "profile_roles", "user_id", m.actorId);
  if (roles.length > 1 || roles.some((row) => row.role !== (m.tier === "pro" ? "manager" : "resident")) || m.registered && roles.length !== 1) fail();
}
async function optionalAbsent(observer: Observer, table: string): Promise<boolean> {
  if (!["payment_reminder_occurrences", "phone_required_skips", "scheduled_inbox_channel_deliveries"].includes(table)) return false;
  const result = await observer.query("select to_regclass(format('public.%I', $1::text)) is null as absent", [table]);
  return result.rows.length === 1 && result.rows[0]?.absent === true;
}
async function preflightActor(deps: CleanupDependencies, r: Reservation, reservations: Reservation[], user: User | null) {
  const m = r.manifest, paired = pairOf(r, reservations);
  await sessionsAbsent(deps.observer, m);
  await inspectIdentity(deps.db, r, user);
  if (!m.actorId) {
    // A start failure before Auth creation has no ID authority; every exact mailbox selector must be empty.
    const { ACCOUNT_PURGE_TABLES } = await import("@/lib/auth/account-purge-manifest");
    for (const rule of ACCOUNT_PURGE_TABLES) {
      const scope = rule[m.tier === "pro" ? "manager" : "resident"];
      for (const column of [...scope?.emails ?? [], ...scope?.detachEmails ?? []]) await zero(deps.db, rule.table, column, m.email, true);
    }
    await zero(deps.db, "sms_phone_contacts", "phone_e164", m.phone);
    return;
  }
  await inspectInline(deps.db, r, paired);
  await inspectPhone(deps.db, m);
  await inspectSignupPurgeCandidates({ db: deps.db, journal: m, paired: paired?.manifest, optionalTableAbsent: (table) => optionalAbsent(deps.observer, table) });
}
async function deleteContact(deps: CleanupDependencies, r: Reservation) {
  const m = r.manifest, contacts = await inspectPhone(deps.db, m);
  if (!contacts.length) { if (m.phoneBound && !m.contactDelete) fail(); return; }
  const contact = contacts[0]!;
  if (m.contactDelete && (m.contactDelete.firstSeenAt !== contact.first_seen_at || m.contactDelete.lastSeenAt !== contact.last_seen_at)) fail();
  m.contactDelete ??= { firstSeenAt: String(contact.first_seen_at), lastSeenAt: String(contact.last_seen_at) };
  persistSignupJournal(r.file, m);
  const removed = await cleanupRows(deps.db.from("sms_phone_contacts").delete().eq("phone_e164", m.phone).eq("user_id", m.actorId).eq("first_seen_at", m.contactDelete.firstSeenAt).eq("last_seen_at", m.contactDelete.lastSeenAt).select("phone_e164"));
  if (removed.length !== 1 || removed[0]?.phone_e164 !== m.phone) fail();
  await zero(deps.db, "sms_phone_contacts", "phone_e164", m.phone);
}
/** Actual orchestration, exported so fault tests exercise the same guard and mutation callchain. */
export async function cleanupSignupReservations(reservations: Reservation[], deps: CleanupDependencies): Promise<void> {
  if ((deps.db as unknown as { supabaseUrl?: string }).supabaseUrl !== DEV || reservations.length > 10 || new Set(reservations.map((r) => r.manifest.email)).size !== reservations.length || new Set(reservations.map((r) => r.manifest.phone)).size !== reservations.length) fail();
  try {
    for (const r of reservations) {
      // Reload prevents an in-memory caller from widening the trusted private reservation.
      r.manifest = readSignupJournal(r.file);
    }
    for (const r of reservations) if (r.manifest.pairedActorId) {
      const linked = reservations.find((item) => item.manifest.actorId === r.manifest.pairedActorId && item.manifest.nonce === r.manifest.pairedNonce);
      if (!linked || linked.manifest.tier === r.manifest.tier) fail();
      if (!linked.manifest.pairedActorId) {
        if ([r, linked].some((item) => item.manifest.inventory?.some((entry) => entry.namespace === "application"))) fail();
        linked.manifest.pairedActorId = r.manifest.actorId; linked.manifest.pairedNonce = r.manifest.nonce;
        persistSignupJournal(linked.file, linked.manifest);
      }
      pairOf(r, reservations);
    }
    for (const values of [reservations.map((r) => r.manifest.email), reservations.map((r) => r.manifest.phone), reservations.map((r) => r.manifest.nonce), reservations.map((r) => r.file), reservations.map((r) => r.manifest.actorId).filter(Boolean)]) if (new Set(values).size !== values.length) fail();
    if (new Set(reservations.map((r) => path.dirname(r.file))).size > 1) fail();
    const users = new Map<string, User>();
    for (const r of reservations) { const user = await authUser(deps.db, r); if (user) users.set(user.id, user); }
    for (const r of reservations) await reconcileInventory(deps.db, r, pairOf(r, reservations));
    // The entire pair is inspected before the first contact or portal mutation.
    for (const r of reservations) await preflightActor(deps, r, reservations, users.get(r.manifest.actorId ?? "") ?? null);
    await inspectCatalog(deps, reservations, users);
    const ordered = [...reservations].sort((a, b) => (a.manifest.tier === "resident" ? 0 : 1) - (b.manifest.tier === "resident" ? 0 : 1));
    for (const r of ordered) {
      const m = r.manifest;
      const user = await authUser(deps.db, r);
      await preflightActor(deps, r, reservations, user);
      if (!user) {
        if (m.actorId) {
          await zero(deps.db, "profiles", "id", m.actorId);
          await zero(deps.db, "profile_roles", "user_id", m.actorId);
          await zero(deps.db, "phone_otp_challenges", "auth_user_id", m.actorId);
        }
        advance(r, "complete"); continue;
      }
      if (m.phase === "complete") fail(); // A foreign replacement cannot turn a completed journal back into authority.
      advance(r, "cleanup-started");
      await deleteContact(deps, r);
      // A stopped pair's current owner predicates are the canonical mutation authority.
      // Recheck identity/cross-owner/provider boundaries immediately before each canonical call.
      await preflightActor(deps, r, reservations, await authUser(deps.db, r));
      await inspectCatalog(deps, reservations, users);
      if (phaseOrder.indexOf(m.phase!) < phaseOrder.indexOf("portal-purged")) {
        if (m.tier === "resident") await (deps.residentPurge ?? purgeResidentPortalData)(deps.db, { userId: m.actorId, email: m.email, complete: true });
        else await (deps.managerPurge ?? purgeManagerPortalData)(deps.db, m.actorId!, true, m.email);
        advance(r, "portal-purged");
      }
      await preflightActor(deps, r, reservations, await authUser(deps.db, r));
      await inspectSignupPurgeCandidates({ db: deps.db, journal: m, paired: pairOf(r, reservations)?.manifest, requireAbsent: true, optionalTableAbsent: (table) => optionalAbsent(deps.observer, table) });
      advance(r, "auth-delete-started");
      const deletion = await deps.db.auth.admin.deleteUser(m.actorId!);
      if (deletion.error) fail();
      users.delete(m.actorId!);
      const absent = await authUser(deps.db, r);
      if (absent) fail();
      await inspectIdentity(deps.db, r, null);
      await zero(deps.db, "profile_roles", "user_id", m.actorId);
      await zero(deps.db, "phone_otp_challenges", "auth_user_id", m.actorId);
      await zero(deps.db, "sms_phone_contacts", "phone_e164", m.phone);
      await sessionsAbsent(deps.observer, m);
      await preflightActor(deps, r, reservations, null);
      await inspectSignupPurgeCandidates({ db: deps.db, journal: m, paired: pairOf(r, reservations)?.manifest, requireAbsent: true, optionalTableAbsent: (table) => optionalAbsent(deps.observer, table) });
      advance(r, "complete");
    }
  } catch { fail(); }
}
export async function finalizeSignupProof(dir: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== DEV || !process.env.SUPABASE_SERVICE_ROLE_KEY) fail();
  proveSignupShutdown(dir, process.env.NEXT_PUBLIC_APP_URL ?? "", process.env.SIGNUP_PROOF_RUN_NONCE ?? "");
  await verifySignupPortClosed(process.env.NEXT_PUBLIC_APP_URL ?? "");
  const names = readdirSync(dir).filter((name) => /^p8-[a-f0-9]{32}\.manifest\.json$/.test(name));
  const reservations = names.map((name) => ({ file: path.join(dir, name), manifest: readSignupJournal(path.join(dir, name)) }));
  const db = createClient(DEV, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) } });
  const lockFile = path.join(dir, "cleanup-owner.json");
  try {
    const stat = lstatSync(lockFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) fail();
    const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number; runNonce: string };
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || owner.runNonce !== process.env.SIGNUP_PROOF_RUN_NONCE) fail();
    try { process.kill(owner.pid, 0); fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") fail(); }
    unlinkSync(lockFile);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, runNonce: process.env.SIGNUP_PROOF_RUN_NONCE }), { flag: "wx", mode: 0o600 });
  const modulePath = "../../scripts/signup-proof-observer.mjs";
  const { connectSignupObserver } = await import(/* @vite-ignore */ modulePath);
  try {
    const observer = await connectSignupObserver();
    try { await cleanupSignupReservations(reservations, { db, observer }); }
    finally { await observer.end(); }
  } finally {
    const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number; runNonce: string };
    if (owner.pid !== process.pid || owner.runNonce !== process.env.SIGNUP_PROOF_RUN_NONCE) fail();
    unlinkSync(lockFile);
  }
}
