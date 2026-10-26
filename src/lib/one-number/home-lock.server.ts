import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { workspaceHasDedicatedNumber } from "@/lib/one-number/config.server";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { streetLine } from "@/lib/one-number/house-redirect";
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
