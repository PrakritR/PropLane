import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import type { ReplyRouteConversation } from "@/lib/vendor-work-number";

/**
 * Who a vendor's PropLane number has texted with: one row per manager line.
 * The reply router reads it ("most recent conversation"). The table ships in
 * migration 20261006200000; before it is applied every call degrades quietly
 * (writes are skipped, reads answer "no conversations") rather than failing a
 * webhook that Twilio would retry forever.
 */
export type VendorNumberConversationTouch = {
  identityId: string;
  vendorUserId: string;
  counterpartPhone: string;
  direction: "inbound" | "outbound";
  managerUserId?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  at?: Date;
};

export async function touchVendorNumberConversation(db: SupabaseClient, input: VendorNumberConversationTouch): Promise<boolean> {
  const counterpartPhone = normalizeE164(input.counterpartPhone);
  if (!counterpartPhone) return false;
  const at = (input.at ?? new Date()).toISOString();
  const row: Record<string, unknown> = {
    identity_id: input.identityId,
    vendor_user_id: input.vendorUserId,
    counterpart_phone: counterpartPhone,
    last_activity_at: at,
    ...(input.direction === "inbound" ? { last_inbound_at: at } : { last_outbound_at: at }),
    ...(input.managerUserId ? { manager_user_id: input.managerUserId } : {}),
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    ...(input.workspaceName ? { workspace_name: input.workspaceName } : {}),
  };
  const { error } = await db.from("vendor_work_number_conversations").upsert(row, { onConflict: "identity_id,counterpart_phone" });
  if (error) {
    console.error("vendor number conversation not recorded", error.message);
    return false;
  }
  return true;
}

export async function listVendorNumberConversations(db: SupabaseClient, identityId: string): Promise<ReplyRouteConversation[]> {
  const { data, error } = await db.from("vendor_work_number_conversations")
    .select("counterpart_phone,workspace_name,last_activity_at")
    .eq("identity_id", identityId)
    .order("last_activity_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("vendor number conversations unavailable", error.message);
    return [];
  }
  return ((data ?? []) as { counterpart_phone: string; workspace_name: string | null; last_activity_at: string }[]).map((row) => ({
    counterpartPhone: row.counterpart_phone,
    workspaceName: String(row.workspace_name ?? "").trim(),
    lastActivityAt: row.last_activity_at,
  }));
}

/** The workspace a manager work line answers for, as the vendor should read it. */
export async function workspaceNameForLine(db: SupabaseClient, line: { workspaceId: string | null; managerId: string }): Promise<string> {
  try {
    if (line.workspaceId) {
      const { data } = await db.from("portal_workspaces").select("name").eq("id", line.workspaceId).maybeSingle();
      const name = String((data as { name?: unknown } | null)?.name ?? "").trim();
      if (name) return name;
    }
    const { data } = await db.from("profiles").select("full_name").eq("id", line.managerId).maybeSingle();
    const name = String((data as { full_name?: unknown } | null)?.full_name ?? "").trim();
    if (name) return name;
  } catch {
    // The label falls back to a generic one; it is never omitted.
  }
  return "PropLane";
}
