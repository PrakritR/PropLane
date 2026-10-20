import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import {
  ROLE_FOR_ROUTING_REASON,
  type SharedLineCandidate,
  type SharedLineRoutingReason,
} from "@/lib/one-number/contracts";
import { normalizeE164 } from "@/lib/phone-e164";
import { applicationBucket, applicationRowLinksResident, isApprovedApplicationRow } from "@/lib/resident-manager-scope";
import { normalizeConsentPhone, profilePhoneVariants } from "@/lib/sms-consent";
import { workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";
import { listResidentBindingManagerIds } from "@/lib/auth/resident-workspace-binding";

/**
 * Every lookup answers one question for ONE phone: "which workspaces know this
 * number in this capacity?". Each is its own function over an injected client so
 * it can be tested with a fake. A read that fails reads as "nothing": routing can
 * then ask or treat the sender as a new prospect, but can never reach a thread the
 * phone has no claim on. Nothing here writes.
 */

type Row = Record<string, unknown>;
type WorkspaceInfo = { id: string; name: string; ownerUserId: string };
type PropertyInfo = { id: string; workspaceId: string | null; managerUserId: string | null; label: string; generalArea: string };

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());

async function rows(
  query: PromiseLike<{ data: unknown; error: { code?: string | null } | null }>,
): Promise<Row[]> {
  try {
    const { data, error } = await query;
    if (error) return [];
    return Array.isArray(data) ? (data as Row[]) : [];
  } catch {
    return [];
  }
}

export function propertyLabel(rowData: unknown): string {
  const data = rowData && typeof rowData === "object" ? (rowData as Record<string, unknown>) : {};
  return str(data.buildingName) || str(data.address);
}

/**
 * The house as a VENDOR may be told it: the general area (neighborhood or city), never the street.
 * A vendor candidate exists while a job is only OFFERED, so the disambiguation question and the
 * dedicated-number redirect must not name the address (docs/agents/services-system.md).
 */
export function propertyGeneralArea(rowData: unknown): string {
  const data = rowData && typeof rowData === "object" ? (rowData as Record<string, unknown>) : {};
  const area = workOrderGeneralArea({ propertyAddress: str(data.address), propertyName: str(data.buildingName) });
  // "Nearby" is the helper's "I cannot tell": the caller then names the workspace instead of a placeholder.
  return area === "Nearby" ? "" : area;
}

async function loadWorkspaceInfo(db: SupabaseClient, workspaceIds: string[]): Promise<Map<string, WorkspaceInfo>> {
  const ids = [...new Set(workspaceIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const data = await rows(db.from("portal_workspaces").select("id, name, owner_user_id").in("id", ids));
  return new Map(
    data.map((r) => [str(r.id), { id: str(r.id), name: str(r.name), ownerUserId: str(r.owner_user_id) }] as const),
  );
}

/** The workspace an owner's house-less rows belong to: their default workspace. */
async function loadDefaultWorkspaces(db: SupabaseClient, ownerIds: string[]): Promise<Map<string, WorkspaceInfo>> {
  const ids = [...new Set(ownerIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const data = await rows(
    db.from("portal_workspaces").select("id, name, owner_user_id").in("owner_user_id", ids).eq("is_default", true),
  );
  return new Map(
    data.map((r) => [str(r.owner_user_id), { id: str(r.id), name: str(r.name), ownerUserId: str(r.owner_user_id) }] as const),
  );
}

async function loadProperties(db: SupabaseClient, propertyIds: string[]): Promise<Map<string, PropertyInfo>> {
  const ids = [...new Set(propertyIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const data = await rows(
    db.from("manager_property_records").select("id, workspace_id, manager_user_id, row_data").in("id", ids),
  );
  return new Map(
    data.map((r) => [
      str(r.id),
      {
        id: str(r.id),
        workspaceId: str(r.workspace_id) || null,
        managerUserId: str(r.manager_user_id) || null,
        label: propertyLabel(r.row_data),
        generalArea: propertyGeneralArea(r.row_data),
      },
    ] as const),
  );
}

type Placement = { managerUserId: string; propertyId: string; live?: "offer" | "accepted" };

/**
 * Turn "manager X, house H" placements into candidates. The house names the
 * workspace (`manager_property_records.workspace_id`); a placement with no house
 * falls to the owner's DEFAULT workspace. Distinct per workspace; the first
 * placement given wins the house label.
 */
async function candidatesForPlacements(
  db: SupabaseClient,
  placements: Placement[],
  reason: SharedLineRoutingReason,
): Promise<SharedLineCandidate[]> {
  const props = await loadProperties(db, placements.map((p) => p.propertyId));
  const ownerFallback = await loadDefaultWorkspaces(
    db,
    placements.filter((p) => !props.get(p.propertyId)?.workspaceId).map((p) => p.managerUserId),
  );
  const workspaces = await loadWorkspaceInfo(
    db,
    placements.map((p) => props.get(p.propertyId)?.workspaceId ?? "").filter(Boolean),
  );
  const role = ROLE_FOR_ROUTING_REASON[reason];
  const out = new Map<string, SharedLineCandidate>();
  for (const placement of placements) {
    const prop = props.get(placement.propertyId);
    const workspace = prop?.workspaceId ? workspaces.get(prop.workspaceId) : ownerFallback.get(placement.managerUserId);
    if (!workspace?.id || !workspace.ownerUserId) continue;
    const already = out.get(workspace.id);
    if (already) {
      // Another placement in the same workspace: the house label stays the first one, but a waiting dispatch is remembered.
      if (placement.live && !already.liveDispatch?.includes(placement.live)) already.liveDispatch = [...(already.liveDispatch ?? []), placement.live];
      continue;
    }
    out.set(workspace.id, {
      workspaceId: workspace.id,
      ownerUserId: workspace.ownerUserId,
      role,
      reason,
      propertyId: prop?.id ?? null,
      label: prop?.label || workspace.name || "your property team",
      ...(prop?.generalArea ? { generalArea: prop.generalArea } : {}),
      ...(workspace.name ? { workspaceName: workspace.name } : {}),
      ...(placement.live ? { liveDispatch: [placement.live] } : {}),
    });
  }
  return [...out.values()];
}

function applicationPlacements(applications: Row[]): Placement[] {
  const placements: Placement[] = [];
  for (const app of applications) {
    const managerUserId = str(app.manager_user_id);
    const data = (app.row_data && typeof app.row_data === "object" ? app.row_data : {}) as Record<string, unknown>;
    const propertyId =
      str(app.assigned_property_id) || str(app.property_id) || str(data.assignedPropertyId) || str(data.propertyId);
    if (managerUserId) placements.push({ managerUserId, propertyId });
  }
  return placements;
}

/** The ONE verified PropLane account for a phone. Two claimants = nobody (fail closed). */
export async function findVerifiedProfileByPhone(
  db: SupabaseClient,
  phone: string,
): Promise<{ id: string; email: string } | null> {
  const variants = profilePhoneVariants(phone);
  if (variants.length === 0) return null;
  const data = await rows(
    db.from("profiles").select("id, email, phone").in("phone", variants).not("phone_verified_at", "is", null).limit(2),
  );
  if (data.length !== 1) return null;
  const id = str(data[0].id);
  return id ? { id, email: str(data[0].email).toLowerCase() } : null;
}

/** Step 1. The sender's verified phone belongs to the owner or an accepted teammate of a workspace. */
export async function findTeamMemberCandidates(db: SupabaseClient, phone: string): Promise<SharedLineCandidate[]> {
  const profile = await findVerifiedProfileByPhone(db, phone);
  if (!profile) return [];
  const owned = await rows(db.from("portal_workspaces").select("id, name, owner_user_id").eq("owner_user_id", profile.id));
  let invites: Row[] = [];
  try {
    const result = withoutOwnerLinks(
      await db
        .from("account_link_invites")
        .select("inviter_user_id, workspace_id, team_role")
        .eq("invitee_user_id", profile.id)
        .eq("status", "accepted"),
    );
    invites = result.error ? [] : ((result.data ?? []) as Row[]);
  } catch {
    invites = [];
  }
  const pinned = await loadWorkspaceInfo(db, invites.map((i) => str(i.workspace_id)));
  const fallback = await loadDefaultWorkspaces(
    db,
    invites.filter((i) => !str(i.workspace_id)).map((i) => str(i.inviter_user_id)),
  );
  const out = new Map<string, SharedLineCandidate>();
  const add = (workspace: WorkspaceInfo | undefined) => {
    if (!workspace?.id || !workspace.ownerUserId || out.has(workspace.id)) return;
    out.set(workspace.id, {
      workspaceId: workspace.id,
      ownerUserId: workspace.ownerUserId,
      role: "manager",
      reason: "team_member",
      propertyId: null,
      label: workspace.name || "your property team",
    });
  };
  for (const w of owned) add({ id: str(w.id), name: str(w.name), ownerUserId: str(w.owner_user_id) });
  for (const invite of invites) {
    add(str(invite.workspace_id) ? pinned.get(str(invite.workspace_id)) : fallback.get(str(invite.inviter_user_id)));
  }
  return [...out.values()];
}

/** Step 2. An approved residency (application record) or a resident binding for the sender's account. */
export async function findResidentCandidates(db: SupabaseClient, phone: string): Promise<SharedLineCandidate[]> {
  const profile = await findVerifiedProfileByPhone(db, phone);
  if (!profile) return [];
  const apps = profile.email
    ? await rows(
        db
          .from("manager_application_records")
          .select("manager_user_id, property_id, assigned_property_id, row_data, updated_at")
          .eq("resident_email", profile.email)
          .order("updated_at", { ascending: false })
          .limit(25),
      )
    : [];
  const placements = applicationPlacements(apps.filter((a) => applicationRowLinksResident(a.row_data) && isApprovedApplicationRow(a)));
  const boundManagerIds = await listResidentBindingManagerIds(db, String(profile.id)).catch(() => [] as string[]);
  for (const managerUserId of boundManagerIds) placements.push({ managerUserId, propertyId: "" });
  return candidatesForPlacements(db, placements, "resident");
}

/** A finished dispatched job stays answerable (photos, an invoice) this long; the same window the dispatch replies use. */
const DISPATCH_COMPLETED_WINDOW_DAYS = 30;

/**
 * Jobs the dispatch engine put in front of this phone: an offer waiting for YES / NO, or an accepted job
 * still open (or finished in the last 30 days). The phone is matched through the manager's vendor roster
 * (`manager_vendor_records.row_data.phone`, any typed format, compared as E.164), so a vendor who only ever
 * texts YES / DONE / a photo (no PropLane login, no vendor agent session) still reaches the team that
 * offered the job. One placement per run: the run's own owner and house name the workspace.
 */
async function dispatchJobPlacements(db: SupabaseClient, e164: string, phone: string): Promise<Placement[]> {
  const key = normalizeConsentPhone(phone);
  if (!/^\d{10}$/.test(key)) return [];
  // A roster phone is whatever the manager typed ("(206) 555-0142", "206.555.0142"): the digit groups in order
  // with anything between them are the candidates, and the E.164 comparison below is the real test.
  const roster = await rows(
    db
      .from("manager_vendor_records")
      .select("id, manager_user_id, row_data")
      .ilike("row_data->>phone", `%${key.slice(0, 3)}%${key.slice(3, 6)}%${key.slice(6)}%`)
      .limit(50),
  );
  const mine = roster.filter((r) => {
    const data = (r.row_data && typeof r.row_data === "object" ? r.row_data : {}) as Row;
    return data.active !== false && normalizeE164(str(data.phone)) === e164;
  });
  if (mine.length === 0) return [];
  const attempts = await rows(
    db
      .from("vendor_dispatch_attempts")
      .select("run_id, vendor_directory_id, status")
      .in("vendor_directory_id", mine.map((r) => str(r.id)))
      .in("status", ["offered", "timed_out", "accepted"])
      .limit(100),
  );
  if (attempts.length === 0) return [];
  const runs = await rows(
    db
      .from("vendor_dispatch_runs")
      .select("id, owner_user_id, property_id, status, completed_at")
      .in("id", [...new Set(attempts.map((a) => str(a.run_id)))])
      .in("status", ["offering", "exhausted", "accepted", "completed"]),
  );
  const runById = new Map(runs.map((r) => [str(r.id), r] as const));
  const recent = Date.now() - DISPATCH_COMPLETED_WINDOW_DAYS * 86_400_000;
  const placements: Placement[] = [];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    const run = runById.get(str(attempt.run_id));
    if (!run || seen.has(str(run.id))) continue;
    const offered = str(attempt.status) !== "accepted";
    const live = offered ? ["offering", "exhausted"].includes(str(run.status)) : ["accepted", "completed"].includes(str(run.status));
    if (!live) continue;
    if (str(run.status) === "completed" && !(Date.parse(str(run.completed_at)) >= recent)) continue;
    seen.add(str(run.id));
    const owner = str(run.owner_user_id);
    // An offer still out to this phone, or a job it took that is open, is waiting on a bare YES / NO / DONE from it.
    const waiting = offered ? (str(attempt.status) === "offered" && str(run.status) === "offering" ? "offer" : undefined) : str(run.status) === "accepted" ? "accepted" : undefined;
    if (owner) placements.push({ managerUserId: owner, propertyId: str(run.property_id), ...(waiting ? { live: waiting } : {}) });
  }
  return placements;
}

/** Step 3. An open job: an active vendor session bound to the sender's phone, or a dispatched job offered or accepted. */
export async function findVendorJobCandidates(db: SupabaseClient, phone: string): Promise<SharedLineCandidate[]> {
  const e164 = normalizeE164(phone);
  if (!e164) return [];
  const sessions = await rows(
    db
      .from("agent_sessions")
      .select("landlord_id, work_order_id, status")
      .eq("kind", "vendor_work_order")
      .eq("vendor_phone_e164", e164)
      .in("status", ["active", "escalated"])
      .order("updated_at", { ascending: false })
      .limit(50),
  );
  const orderIds = [...new Set(sessions.map((s) => str(s.work_order_id)).filter(Boolean))];
  const orders = orderIds.length
    ? await rows(
        db.from("portal_work_order_records").select("id, property_id, assigned_property_id, row_data").in("id", orderIds),
      )
    : [];
  const houseByOrder = new Map<string, string>();
  for (const order of orders) {
    const data = (order.row_data && typeof order.row_data === "object" ? order.row_data : {}) as Record<string, unknown>;
    const house = str(order.assigned_property_id) || str(order.property_id) || str(data.propertyId);
    if (house) houseByOrder.set(str(order.id), house);
  }
  const placements: Placement[] = [];
  for (const session of sessions) {
    const managerUserId = str(session.landlord_id);
    if (managerUserId) placements.push({ managerUserId, propertyId: houseByOrder.get(str(session.work_order_id)) ?? "" });
  }
  placements.push(...(await dispatchJobPlacements(db, e164, phone).catch(() => [] as Placement[])));
  return candidatesForPlacements(db, placements, "vendor_job");
}

/**
 * Step 4. An open application (not approved, rejected or withdrawn) belonging to this phone's VERIFIED account.
 *
 * `row_data->>phone` is whatever the applicant typed, so anyone could file an application naming someone else's
 * number and attach a candidate workspace to that person's texts - and the disambiguation question is sent from
 * (and billed to) the first candidate's workspace. So the phone must first resolve to one verified PropLane
 * account, exactly as the resident, team and member lookups require, and a row matched by its typed phone counts
 * only when it also carries that account's own email.
 */
export async function findApplicantCandidates(db: SupabaseClient, phone: string): Promise<SharedLineCandidate[]> {
  const profile = await findVerifiedProfileByPhone(db, phone);
  if (!profile?.email) return [];
  const variants = profilePhoneVariants(phone);
  const byPhone = variants.length
    ? await rows(
        db
          .from("manager_application_records")
          .select("manager_user_id, property_id, assigned_property_id, resident_email, row_data, updated_at")
          .in("row_data->>phone", variants)
          .order("updated_at", { ascending: false })
          .limit(25),
      )
    : [];
  const ownsRow = (row: Row): boolean => {
    const data = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>;
    return str(row.resident_email).toLowerCase() === profile.email || str(data.email).toLowerCase() === profile.email;
  };
  const byEmail = await rows(
    db
      .from("manager_application_records")
      .select("manager_user_id, property_id, assigned_property_id, resident_email, row_data, updated_at")
      .eq("resident_email", profile.email)
      .order("updated_at", { ascending: false })
      .limit(25),
  );
  const open = [...byPhone.filter(ownsRow), ...byEmail].filter((a) => {
    if (!applicationRowLinksResident(a.row_data)) return false;
    return applicationBucket(a.row_data) !== "approved";
  });
  return candidatesForPlacements(db, applicationPlacements(open), "applicant");
}

/** Step 5. A prospect conversation this phone already has with a workspace. */
export async function findReturningProspectCandidates(db: SupabaseClient, phone: string): Promise<SharedLineCandidate[]> {
  const e164 = normalizeE164(phone);
  if (!e164) return [];
  let contacts: Row[];
  try {
    const { data, error } = await db
      .from("manager_sms_contacts")
      .select("manager_user_id, workspace_id")
      .eq("phone_e164", e164)
      .eq("counterparty_role", "prospect")
      .limit(20);
    if (error && isMissingSchemaError(error)) {
      // Before the workspace stamp exists, a contact belongs to its owner's default workspace.
      contacts = await rows(
        db.from("manager_sms_contacts").select("manager_user_id").eq("phone_e164", e164).eq("counterparty_role", "prospect").limit(20),
      );
    } else {
      contacts = error ? [] : ((data ?? []) as Row[]);
    }
  } catch {
    return [];
  }
  const stamped = await loadWorkspaceInfo(db, contacts.map((c) => str(c.workspace_id)));
  const fallback = await loadDefaultWorkspaces(
    db,
    contacts.filter((c) => !str(c.workspace_id)).map((c) => str(c.manager_user_id)),
  );
  const out = new Map<string, SharedLineCandidate>();
  for (const contact of contacts) {
    const workspace = str(contact.workspace_id) ? stamped.get(str(contact.workspace_id)) : fallback.get(str(contact.manager_user_id));
    if (!workspace?.id || !workspace.ownerUserId || out.has(workspace.id)) continue;
    out.set(workspace.id, {
      workspaceId: workspace.id,
      ownerUserId: workspace.ownerUserId,
      role: "prospect",
      reason: "returning_prospect",
      propertyId: null,
      label: workspace.name || "your property team",
    });
  }
  return [...out.values()];
}

/** The whole-word tokens of a text, as an entry code could appear in it (A-Z0-9, 3-16). */
export function entryCodeTokens(body: string): string[] {
  const tokens = String(body ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 3 && t.length <= 16);
  return [...new Set(tokens)].slice(0, 25);
}

/** Step 6. The text contains an active entry code as a whole token. First token in the text wins. */
export async function findEntryCodeCandidate(db: SupabaseClient, body: string): Promise<SharedLineCandidate | null> {
  const tokens = entryCodeTokens(body);
  if (tokens.length === 0) return null;
  const codes = await rows(
    db.from("sms_entry_codes").select("code, workspace_id, owner_user_id, property_id, label, active").in("code", tokens).eq("active", true),
  );
  if (codes.length === 0) return null;
  const byCode = new Map(codes.map((c) => [str(c.code), c] as const));
  const hit = tokens.map((t) => byCode.get(t)).find(Boolean);
  if (!hit) return null;
  const workspaceId = str(hit.workspace_id);
  const workspace = (await loadWorkspaceInfo(db, [workspaceId])).get(workspaceId);
  // A code whose row disagrees with the workspace's real owner is corrupt: never route on it.
  if (!workspace || workspace.ownerUserId !== str(hit.owner_user_id)) return null;
  const prop = (await loadProperties(db, [str(hit.property_id)])).get(str(hit.property_id));
  if (prop?.workspaceId && prop.workspaceId !== workspaceId) return null;
  return {
    workspaceId,
    ownerUserId: workspace.ownerUserId,
    role: "prospect",
    reason: "entry_code",
    propertyId: str(hit.property_id) || null,
    label: str(hit.label) || prop?.label || workspace.name || "your property team",
  };
}

/** A workspace by id, as a prospect candidate (a lead that picked or toured one of its rooms). */
export async function findWorkspaceProspectCandidate(
  db: SupabaseClient,
  workspaceId: string,
): Promise<SharedLineCandidate | null> {
  const workspace = (await loadWorkspaceInfo(db, [workspaceId])).get(workspaceId);
  if (!workspace?.ownerUserId) return null;
  return {
    workspaceId: workspace.id,
    ownerUserId: workspace.ownerUserId,
    role: "prospect",
    reason: "returning_prospect",
    propertyId: null,
    label: workspace.name || "your property team",
  };
}
