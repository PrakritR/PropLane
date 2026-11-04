import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatInboxStamp } from "@/lib/portal-inbox-storage";

/** Persist the manager's service-scoped conversation before acknowledging ingress.
 * Only the service-role caller can use this; the RPC re-derives the owner/record. */
export async function notifyVendorQuoteResponse(db: SupabaseClient, input: {
  sessionToken?: string; capabilityId?: string; sourceMessageId: string; body: string; channel: "email" | "portal";
}) {
  let capabilityId = input.capabilityId;
  if (!capabilityId && input.sessionToken) {
    const { data, error } = await db.from("vendor_quote_contact_sessions").select("capability_id")
      .eq("session_digest", createHash("sha256").update(input.sessionToken).digest("hex")).maybeSingle();
    if (error || !data) throw new Error("Quote conversation unavailable.");
    capabilityId = String(data.capability_id);
  }
  if (!capabilityId) throw new Error("Quote conversation unavailable.");
  const { error } = await db.rpc("append_vendor_quote_inbox", { p_capability_id: capabilityId,
    p_source_message_id: input.sourceMessageId.slice(0, 200), p_body: input.body.slice(0, 6000),
    p_channel: input.channel, p_stamp: formatInboxStamp(new Date()),
  });
  if (error) throw new Error("Quote conversation could not be saved.");
}
