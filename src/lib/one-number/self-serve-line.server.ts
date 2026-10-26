import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { managerPersonalNumberEntitlement } from "@/lib/one-number/personal-number-entitlement.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { formatUsPhoneDisplay, normalizeE164 } from "@/lib/phone-e164";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";

/**
 * Who the PropLane line serves: homes PropLane manages (workspaces carrying `is_service`, and anything the line's own
 * owner holds). A SELF-SERVE workspace (a manager who runs their own houses) is not served here: its owner, its team, its
 * residents and its vendors are pointed at that workspace's own work number when its owner PAYS for one, and otherwise at
 * the pricing page. This module is the one place that decides "paid number" and "managed", for the member, resident,
 * vendor and home-question paths alike.
 */

export const SELF_SERVE_PRICING_REPLY = "This line is for homes PropLane manages. A personal work number comes with Pro: proplane.ai/pricing";

/** "This line is for homes PropLane manages. Text your work number (502) 555-0142." Several numbers are joined with "or". */
export function buildSelfServeLineReply(numbers: readonly string[]): string {
  const shown = [...new Set(numbers.map((n) => normalizeE164(n)).filter((n): n is string => Boolean(n)))].map(formatUsPhoneDisplay);
  if (shown.length === 0) return SELF_SERVE_PRICING_REPLY;
  return toGsm7(`This line is for homes PropLane manages. Text your work number ${shown.join(" or ")}.`);
}

/**
 * The work number a workspace's owner PAYS for and can send from, or null. `managerPersonalNumberEntitlement` is the one
 * answer to "paid" (a Pro or Business plan, or the PropLane Number add-on; a signup trial and a lapsed plan do not count),
 * and the number must be one the workspace can actually send from. An entitlement that cannot be read is no number: this
 * never names a number on a guess.
 */
export async function paidWorkNumberFor(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId?: string | null },
): Promise<string | null> {
  const owner = input.ownerUserId.trim();
  if (!owner) return null;
  try {
    const entitlement = await managerPersonalNumberEntitlement(db, owner);
    if (!entitlement.ok || !entitlement.entitled) return null;
    return normalizeE164(await resolveActiveManagerSendNumber(db, owner, input.workspaceId ?? null));
  } catch {
    return null;
  }
}

export type LineWorkspaceKind = "managed" | "self_serve";

/**
 * Managed or self-serve, for each workspace id. Managed = `is_service`, or owned by the line's own owner (their workspaces
 * are the PropLane line's own). A workspace that cannot be read is absent from the map and is treated as self-serve by
 * every caller (it is served less, never more). Null when the read fails.
 */
export async function classifyLineWorkspaces(
  db: SupabaseClient,
  workspaceIds: readonly string[],
  lineOwnerUserId: string | null | undefined,
): Promise<Map<string, LineWorkspaceKind> | null> {
  const ids = [...new Set(workspaceIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, LineWorkspaceKind>();
  if (ids.length === 0) return out;
  const { data, error } = await db.from("portal_workspaces").select("id, owner_user_id, is_service").in("id", ids);
  if (error) return null;
  for (const row of (data ?? []) as Array<{ id?: unknown; owner_user_id?: unknown; is_service?: unknown }>) {
    const id = String(row.id ?? "").trim();
    if (!id) continue;
    const managed = row.is_service === true || (Boolean(lineOwnerUserId) && String(row.owner_user_id ?? "").trim() === lineOwnerUserId);
    out.set(id, managed ? "managed" : "self_serve");
  }
  return out;
}

/** The reply for someone whose only ties are self-serve workspaces: their paid work number(s), else the pricing page. */
export async function selfServeLineReply(db: SupabaseClient, workspaces: ReadonlyArray<{ ownerUserId: string; workspaceId: string }>): Promise<string> {
  const numbers: string[] = [];
  for (const ws of workspaces) {
    const number = await paidWorkNumberFor(db, ws);
    if (number) numbers.push(number);
  }
  return buildSelfServeLineReply(numbers);
}
