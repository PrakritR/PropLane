import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { workspaceHasDedicatedNumber } from "@/lib/one-number/config.server";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { streetLine } from "@/lib/one-number/house-redirect";
import { readSessionSnapshot, revertSharedLineRoute, saveSharedLineRouteIf } from "@/lib/one-number/session.server";
import type { LineTier } from "@/lib/one-number/line-tier";
import { normalizeE164 } from "@/lib/phone-e164";
import { tagConversationHouse } from "@/lib/sms/conversation-houses.server";

/**
 * The database side of the home lock: reading the home a phone is locked to, and the few rows the lock may write into a
 * manager's Communication. Everything that lands in a workspace here is one of exactly three things: the "Looking for"
 * summary when a phone locks to a PropLane-managed or free-manager home, and (for a PAID manager's home) the one interest
 * text plus the reply that gave their number. The browsing transcript and the switch question never come through here.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export function e164FromPhoneKey(phoneKey: string): string {
  const digits = phoneKey.replace(/\D/g, "");
  return normalizeE164(digits.length === 10 ? `+1${digits}` : `+${digits}`) ?? `+${digits}`;
}

/** Does `workspaceId` carry the PropLane Service flag? A failed or absent read is NOT a service workspace (fail closed). */
export async function workspaceIsService(db: SupabaseClient, workspaceId: string): Promise<boolean> {
  if (!workspaceId) return false;
  const { data, error } = await db.from("portal_workspaces").select("is_service").eq("id", workspaceId).maybeSingle();
  if (error) return false;
  return (data as Row | null)?.is_service === true;
}

export type LockedHome = {
  propertyId: string;
  workspaceId: string;
  ownerUserId: string;
  /** "4709A 8th Ave NE": the street line, else the building name. Never a city, a unit or a code. */
  label: string;
  tier: LineTier;
};

/**
 * A live home by id, with its workspace, owner and tier, read from the database (never from an offer the prospect was
 * shown). Null when the home is gone, not live or has no workspace. A workspace is `managed` when it carries `is_service`,
 * `paid` when it holds a personal number, otherwise `free`.
 */
export async function loadHome(db: SupabaseClient, propertyId: string, config: Pick<SharedLineConfig, "dedicatedWorkspaceIds"> | null): Promise<LockedHome | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const res = await db.from("manager_property_records").select("id, workspace_id, manager_user_id, status, property_data, row_data").eq("id", id).maybeSingle();
  const house = res.data as Row | null;
  if (res.error || !house || str(house.status) !== "live") return null;
  let workspaceId = str(house.workspace_id);
  if (!workspaceId) {
    const owned = await db.from("portal_workspaces").select("id").eq("owner_user_id", str(house.manager_user_id)).eq("is_default", true).maybeSingle();
    workspaceId = str((owned.data as Row | null)?.id);
  }
  if (!workspaceId) return null;
  const ws = await db.from("portal_workspaces").select("id, owner_user_id, is_service").eq("id", workspaceId).maybeSingle();
  const workspace = ws.data as Row | null;
  const ownerUserId = str(workspace?.owner_user_id) || str(house.manager_user_id);
  if (!ownerUserId) return null;
  const data = (house.property_data && typeof house.property_data === "object" ? house.property_data : house.row_data) as Row | null;
  const label = streetLine(str(data?.address)) || str(data?.buildingName) || "this home";
  const tier: LineTier = workspace?.is_service === true ? "managed" : config && workspaceHasDedicatedNumber(config as SharedLineConfig, workspaceId) ? "paid" : "free";
  return { propertyId: id, workspaceId, ownerUserId, label, tier };
}

/** The first name of a workspace owner, from their profile. Null when unreadable or unnamed. */
export async function ownerFirstName(db: SupabaseClient, ownerUserId: string): Promise<string | null> {
  try {
    const { data, error } = await db.from("profiles").select("full_name").eq("id", ownerUserId).maybeSingle();
    if (error) return null;
    const first = str((data as Row | null)?.full_name).split(/\s+/)[0] ?? "";
    return first || null;
  } catch {
    return null;
  }
}

/** The house the thread is about, so the owner and the co-hosts who hold that house (and nobody else) see it. */
export async function tagLockedHouse(db: SupabaseClient, input: { ownerUserId: string; phoneE164: string; propertyId: string }): Promise<void> {
  await tagConversationHouse(db, {
    managerUserId: input.ownerUserId,
    conversationKey: buildConversationKey({ ownerManagerUserId: input.ownerUserId, role: "prospect", counterpartyUserId: null, counterpartyPhone: input.phoneE164 }),
    propertyId: input.propertyId,
    source: "leasing",
  }).catch(() => false);
}

/** The "Looking for: ..." summary, as the first row of the locked manager's conversation. Idempotent per (lead, home). */
export async function writeLookingForTurn(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; phoneE164: string; linePhone: string; text: string; leadId: string; propertyId: string; at: string },
): Promise<void> {
  await logManagerSmsMessage(db, {
    managerUserId: input.ownerUserId,
    residentPhone: input.phoneE164,
    direction: "outbound",
    body: input.text,
    fromPhone: input.linePhone,
    toPhone: input.phoneE164,
    messageSid: `lookingfor:${input.leadId}:${input.propertyId}`,
    createdAt: input.at,
    source: "automated",
    counterpartyRole: "prospect",
    workspaceId: input.workspaceId,
  }).catch(() => false);
}

/**
 * A prospect's interest in a PAID manager's home: ONLY the interest text and the reply that gave the manager's number are
 * written into that manager's workspace Communication (a prospect conversation, through the conversation key, tagged with
 * the home), so when the prospect texts the manager's own number it continues in the same conversation. Nothing else the
 * prospect said on the PropLane line ever reaches that workspace.
 */
export async function recordPaidInterest(
  db: SupabaseClient,
  input: { home: LockedHome; phoneE164: string; linePhone: string; interestText: string; replyText: string; key: string; at: string },
): Promise<void> {
  const base = {
    managerUserId: input.home.ownerUserId,
    residentPhone: input.phoneE164,
    counterpartyRole: "prospect" as const,
    workspaceId: input.home.workspaceId,
    source: "work_number" as const,
  };
  await logManagerSmsMessage(db, {
    ...base,
    direction: "inbound",
    body: input.interestText,
    fromPhone: input.phoneE164,
    toPhone: input.linePhone,
    messageSid: `interest:${input.key}`,
    createdAt: input.at,
  }).catch(() => false);
  await logManagerSmsMessage(db, {
    ...base,
    direction: "outbound",
    body: input.replyText,
    fromPhone: input.linePhone,
    toPhone: input.phoneE164,
    messageSid: `interest-reply:${input.key}`,
    createdAt: new Date(Date.parse(input.at) + 1000).toISOString(),
  }).catch(() => false);
  await tagLockedHouse(db, { ownerUserId: input.home.ownerUserId, phoneE164: input.phoneE164, propertyId: input.home.propertyId });
}

// ---------------------------------------------------------------------------
// One ordered, conditional unit: claim the lead, then lock the phone
// ---------------------------------------------------------------------------

export type ClaimTarget = { workspaceId: string; propertyId: string | null };

export type ClaimAndLock =
  /** Both writes applied. Everything that tells anyone the home is theirs may run now. */
  | { kind: "won" }
  /** The claim matched no row. `same` = the lead is stored as assigned to exactly this target AND the phone's lock is this target. */
  | { kind: "lost"; same: boolean }
  /** Nothing is claimed or locked: an unreadable session, a claim error, or a lock that did not apply (the claim is rolled back). */
  | { kind: "unavailable" };

async function rollbackClaim(db: SupabaseClient, lead: { id: string; profile: unknown }, target: ClaimTarget, at: string): Promise<void> {
  try {
    let q = db
      .from("sms_unassigned_leads")
      .update({ status: "open", assigned_workspace_id: null, assigned_property_id: null, assigned_at: null, profile: lead.profile, updated_at: new Date().toISOString() })
      .eq("id", lead.id)
      .eq("status", "assigned")
      .eq("assigned_workspace_id", target.workspaceId)
      .eq("assigned_at", at);
    q = target.propertyId ? q.eq("assigned_property_id", target.propertyId) : q.is("assigned_property_id", null);
    const { error } = await q.select("id");
    if (error) console.error("lead claim rollback failed", error.code ?? "unknown");
  } catch {
    console.error("lead claim rollback failed", "thrown");
  }
}

async function storedAssignmentIs(db: SupabaseClient, leadId: string, phoneKey: string, target: ClaimTarget): Promise<boolean> {
  try {
    const { data, error } = await db.from("sms_unassigned_leads").select("status, assigned_workspace_id, assigned_property_id").eq("id", leadId).maybeSingle();
    const row = data as Row | null;
    if (error || !row) return false;
    if (str(row.status) !== "assigned" || str(row.assigned_workspace_id) !== target.workspaceId || str(row.assigned_property_id) !== (target.propertyId ?? "")) return false;
    const session = await readSessionSnapshot(db, phoneKey);
    return !!session && session.exists && session.workspaceId === target.workspaceId && session.lockedPropertyId === target.propertyId;
  } catch {
    return false;
  }
}

/**
 * Move a lead to ONE target and lock its phone there as one ordered unit:
 *   1. read the session (unreadable = stop, nothing written);
 *   2. CLAIM the lead (`status = 'open'` compare-and-swap that returns the row); no row = lost, and a loser writes no lock;
 *   3. write the LOCK conditionally on the lock values read in step 1; if that fails or matches nothing, the claim is
 *      rolled back (only the exact values this request set) and the move is `unavailable`.
 * The caller records the success reply and every other effect only after `won`.
 */
export async function claimLeadAndLock(
  db: SupabaseClient,
  input: { lead: { id: string; phoneKey: string; profile: unknown }; target: ClaimTarget; at: string; assignedProfile: unknown },
): Promise<ClaimAndLock> {
  const { lead, target, at } = input;
  const prior = await readSessionSnapshot(db, lead.phoneKey);
  if (!prior) return { kind: "unavailable" };
  let claimed: { error: unknown; rows: number };
  try {
    const res = await db
      .from("sms_unassigned_leads")
      .update({ status: "assigned", assigned_workspace_id: target.workspaceId, assigned_property_id: target.propertyId, assigned_at: at, profile: input.assignedProfile, updated_at: at })
      .eq("id", lead.id)
      .eq("status", "open")
      .select("id");
    claimed = { error: res.error, rows: res.data?.length ?? 0 };
  } catch (error) {
    claimed = { error, rows: 0 };
  }
  if (claimed.error) {
    // The outcome is unknown: undo exactly this request's values if they did land.
    await rollbackClaim(db, lead, target, at);
    return { kind: "unavailable" };
  }
  if (claimed.rows === 0) return { kind: "lost", same: await storedAssignmentIs(db, lead.id, lead.phoneKey, target) };
  const route = { workspaceId: target.workspaceId, role: "prospect" as const, lockedPropertyId: target.propertyId };
  const saved = await saveSharedLineRouteIf(db, lead.phoneKey, route, prior, at);
  if (saved.kind === "written") return { kind: "won" };
  // A known conflict (unique violation, or no row matched the prior revision) wrote nothing: the session is someone else's
  // and is never touched. Only an unknown outcome may have landed, and the undo matches our exact revision (`updated_at = at`).
  if (saved.kind === "unknown") {
    await revertSharedLineRoute(db, lead.phoneKey, { workspaceId: target.workspaceId, lockedPropertyId: target.propertyId, at, updatedAt: at }, prior);
  }
  await rollbackClaim(db, lead, target, at);
  return { kind: "unavailable" };
}
