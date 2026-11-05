/** Private, atomic signup recovery journal. It never authorizes deletion by itself. */
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const DEV = "https://emstjswhotsnyksqhqyf.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type SignupJournal = {
  schemaVersion: 1; target: typeof DEV; nonce: string; absentBeforeSignup: true;
  email: string; phone: string; fullName: string; tier: "pro" | "resident"; startedAt: string;
  registered?: boolean; phoneBound?: boolean;
  phase?: "reserved" | "registered" | "phone-bound" | "cleanup-started" | "portal-purged" | "auth-delete-started" | "complete";
  contactDelete?: { firstSeenAt: string; lastSeenAt: string };
  actorId?: string; actorCreatedAt?: string; managerAxisId?: string; pairedActorId?: string; pairedNonce?: string;
  inventory?: Array<{ namespace: "property" | "listing" | "application" | "resident-threads"; state: "unresolved" | "resolved" | "absent"; actorId: string; marker: string; id?: string; ids?: string[]; propertyId?: string; residentActorId?: string }>;
};
function refuse(): never { throw new Error("Signup recovery journal refused."); }
function exactKeys(value: object, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) refuse();
}
function validate(file: string, journal: SignupJournal): void {
  if (!journal || typeof journal !== "object") refuse();
  exactKeys(journal, ["schemaVersion", "target", "nonce", "absentBeforeSignup", "email", "phone", "fullName", "tier", "startedAt", "actorId", "actorCreatedAt", "managerAxisId", "pairedActorId", "pairedNonce", "inventory", "phase", "contactDelete", "registered", "phoneBound"]);
  const nonce = journal.nonce;
  if (!path.isAbsolute(file) || journal.schemaVersion !== 1 || journal.target !== DEV || journal.absentBeforeSignup !== true || !/^[a-f0-9]{32}$/.test(nonce) || path.basename(file) !== `p8-${nonce}.manifest.json` || !new RegExp(`^p8-(manager-${nonce}-(draft|listing)|resident-${nonce}-resident)@example\\.invalid$`).test(journal.email) || !/^\+120655501[0-9]{2}$/.test(journal.phone) || (journal.tier !== "pro" && journal.tier !== "resident") || (journal.tier === "resident") !== journal.email.startsWith("p8-resident-") || !/^P8 (draft|listing|resident) manager$/.test(journal.fullName) || !Number.isFinite(Date.parse(journal.startedAt)) || (journal.actorId !== undefined && !UUID.test(journal.actorId)) || ((journal.pairedActorId === undefined) !== (journal.pairedNonce === undefined)) || (journal.pairedActorId !== undefined && (!UUID.test(journal.pairedActorId) || journal.pairedActorId === journal.actorId || !/^[a-f0-9]{32}$/.test(journal.pairedNonce ?? "") || journal.pairedNonce === nonce))) refuse();
  if ((journal.registered !== undefined && typeof journal.registered !== "boolean") || (journal.phoneBound !== undefined && typeof journal.phoneBound !== "boolean") || (journal.phoneBound && !journal.registered)) refuse();
  const phases = ["reserved", "registered", "phone-bound", "cleanup-started", "portal-purged", "auth-delete-started", "complete"];
  if (journal.phase !== undefined && !phases.includes(journal.phase)) refuse();
  if (journal.contactDelete !== undefined) {
    exactKeys(journal.contactDelete, ["firstSeenAt", "lastSeenAt"]);
    if (![journal.contactDelete.firstSeenAt, journal.contactDelete.lastSeenAt].every((time) => typeof time === "string" && Number.isFinite(Date.parse(time)))) refuse();
  }
  if (journal.managerAxisId !== undefined && (journal.tier !== "pro" || !/^(?:PROPLANE-[A-F0-9]{8}|AXIS-[A-Z0-9-]{1,100})$/.test(journal.managerAxisId))) refuse();
  if (journal.actorCreatedAt !== undefined && (!journal.actorId || !Number.isFinite(Date.parse(journal.actorCreatedAt)))) refuse();
  const dir = lstatSync(path.dirname(file));
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700 || (process.getuid && dir.uid !== process.getuid())) refuse();
  if (journal.inventory !== undefined) {
    if (!Array.isArray(journal.inventory)) refuse();
    const seen = new Set<string>();
    for (const item of journal.inventory) {
      if (!item || typeof item !== "object") refuse();
      exactKeys(item, ["namespace", "state", "actorId", "marker", "id", "ids", "propertyId", "residentActorId"]);
      if (!(["property", "listing", "application", "resident-threads"] as string[]).includes(item.namespace) || seen.has(item.namespace) || !journal.actorId || item.actorId !== journal.actorId || typeof item.marker !== "string" || !item.marker.includes(nonce) || !/^[a-zA-Z0-9_-]{1,160}$/.test(item.marker) || !["resolved", "unresolved", "absent"].includes(item.state) || (item.state === "resolved") !== (typeof item.id === "string" && item.id.length > 0 || item.namespace === "resident-threads" && Array.isArray(item.ids)) || [item.id, item.propertyId].some((s) => s !== undefined && (typeof s !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(s)))) refuse();
      if (item.residentActorId !== undefined && (typeof item.residentActorId !== "string" || !UUID.test(item.residentActorId))) refuse();
      if (item.ids !== undefined && (item.namespace !== "resident-threads" || !Array.isArray(item.ids) || item.ids.length > 100 || new Set(item.ids).size !== item.ids.length || item.ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)))) refuse();
      seen.add(item.namespace);
    }
  }
}
/** Read only a regular private journal and return only schema-validated data. */
export function readSignupJournal(file: string): SignupJournal {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 1_000_000) refuse();
    const journal = JSON.parse(readFileSync(file, "utf8")) as SignupJournal;
    validate(file, journal);
    return journal;
  } catch { return refuse(); }
}
/** Writes and fsyncs a private temporary file, atomically replaces the journal, and fsyncs its directory. */
export function persistSignupJournal(file: string, journal: SignupJournal): void {
  validate(file, journal);
  let exists = false;
  try {
    const existing = lstatSync(file);
    exists = true;
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o777) !== 0o600 || (process.getuid && existing.uid !== process.getuid())) refuse();
    const previous = JSON.parse(readFileSync(file, "utf8")) as SignupJournal;
    validate(file, previous);
    const phases = ["reserved", "registered", "phone-bound", "cleanup-started", "portal-purged", "auth-delete-started", "complete"];
    if ((previous.registered && !journal.registered) || (previous.phoneBound && !journal.phoneBound)) refuse();
    if (phases.indexOf(journal.phase ?? "reserved") < phases.indexOf(previous.phase ?? "reserved") || (previous.contactDelete && JSON.stringify(previous.contactDelete) !== JSON.stringify(journal.contactDelete))) refuse();
    if (previous.managerAxisId && previous.managerAxisId !== journal.managerAxisId) refuse();
    if (previous.actorCreatedAt && previous.actorCreatedAt !== journal.actorCreatedAt) refuse();
    if (previous.nonce !== journal.nonce || previous.email !== journal.email || previous.startedAt !== journal.startedAt || previous.phone !== journal.phone || previous.fullName !== journal.fullName || previous.tier !== journal.tier || (previous.actorId && previous.actorId !== journal.actorId) || (previous.pairedActorId && (previous.pairedActorId !== journal.pairedActorId || previous.pairedNonce !== journal.pairedNonce)) || (previous.inventory ?? []).some((old) => { const current = journal.inventory?.find((item) => item.namespace === old.namespace); return !current || current.actorId !== old.actorId || current.marker !== old.marker || (old.state === "resolved" && JSON.stringify(current) !== JSON.stringify(old)); })) refuse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(journal)); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (exists) renameSync(temporary, file);
    else { linkSync(temporary, file); unlinkSync(temporary); }
    const dir = openSync(path.dirname(file), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
/** Reconcile the exact pre-reserved mailbox after start, including an ambiguous/failed response. */
export async function identifySignupActor(db: SupabaseClient, reservation: { manifest: SignupJournal; file: string }): Promise<string | null> {
  const { manifest, file } = reservation;
  validate(file, manifest);
  let match: { id: string; email?: string; created_at: string } | undefined;
  let complete = false;
  for (let page = 1; page <= 1000; page++) {
    let result;
    try { result = await db.auth.admin.listUsers({ page, perPage: 1000 }); } catch { return refuse(); }
    if (!result || result.error || !Array.isArray(result.data?.users)) refuse();
    for (const user of result.data.users) if (typeof user?.email === "string" && user.email.toLowerCase() === manifest.email) {
      if (match) refuse();
      match = user;
    }
    if (result.data.users.length < 1000) { complete = true; break; }
  }
  if (!complete) refuse();
  if (!match) { if (manifest.actorId) refuse(); return null; }
  if (typeof match.id !== "string" || !UUID.test(match.id) || (manifest.actorId && manifest.actorId !== match.id)) refuse();
  let result;
  try { result = await db.auth.admin.getUserById(match.id); } catch { return refuse(); }
  const detail = result?.data?.user;
  if (!result || result.error || !detail || typeof detail !== "object" || Array.isArray(detail)) refuse();
  if (detail.id !== match.id || (manifest.actorId && detail.id !== manifest.actorId) || typeof detail.email !== "string" || detail.email.toLowerCase() !== match.email?.toLowerCase() || detail.email.toLowerCase() !== manifest.email) refuse();
  if (typeof detail.created_at !== "string" || !Number.isFinite(Date.parse(detail.created_at)) || detail.created_at !== match.created_at || Date.parse(detail.created_at) < Date.parse(manifest.startedAt) || (manifest.actorCreatedAt && manifest.actorCreatedAt !== detail.created_at)) refuse();
  if (detail.app_metadata?.proplane_email_onboarding !== true || !Array.isArray(detail.identities) || detail.identities.length === 0 || detail.identities.some((identity) => !identity || typeof identity !== "object" || Array.isArray(identity) || identity.provider !== "email")) refuse();
  const updated = { ...manifest, actorId: detail.id, actorCreatedAt: detail.created_at };
  persistSignupJournal(file, updated);
  manifest.actorId = updated.actorId; manifest.actorCreatedAt = updated.actorCreatedAt;
  return detail.id;
}

/** Persist the unique manager/resident relationship before either can create linked records. */
export function linkSignupJournals(manager: { file: string; manifest: SignupJournal }, resident: { file: string; manifest: SignupJournal }): void {
  if (manager.manifest.tier !== "pro" || resident.manifest.tier !== "resident" || !manager.manifest.actorId || !resident.manifest.actorId || manager.manifest.actorId === resident.manifest.actorId || manager.manifest.nonce === resident.manifest.nonce || path.dirname(manager.file) !== path.dirname(resident.file)) refuse();
  for (const [current, other] of [[manager, resident], [resident, manager]] as const) {
    if ((current.manifest.pairedActorId && current.manifest.pairedActorId !== other.manifest.actorId) || (current.manifest.pairedNonce && current.manifest.pairedNonce !== other.manifest.nonce)) refuse();
  }
  manager.manifest.pairedActorId = resident.manifest.actorId; manager.manifest.pairedNonce = resident.manifest.nonce;
  resident.manifest.pairedActorId = manager.manifest.actorId; resident.manifest.pairedNonce = manager.manifest.nonce;
  persistSignupJournal(manager.file, manager.manifest);
  persistSignupJournal(resident.file, resident.manifest);
}
