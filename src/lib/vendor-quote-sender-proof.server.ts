import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SenderPolicyReadContext } from "@/lib/one-number/sender-policy-read.server";
import type { VendorQuoteSenderIdentity } from "@/lib/vendor-quote-contract";
import { resolveVendorOutreachIdentity, vendorQuoteSenderKey, vendorQuoteSenderMatches } from "@/lib/vendor-outreach-identity.server";

export type VendorQuoteSenderProof = {
  capabilityId: string;
  revision: string;
  evaluatedAt: string;
  validUntil: string;
  channel: "email" | "sms";
  senderKey: string;
  senderSnapshot: VendorQuoteSenderIdentity;
};

/** No policy cache or reconciliation writes are allowed between revision read and proof consumption. */
export async function resolveVendorQuoteSenderProof(
  db: SupabaseClient,
  cap: Record<string, unknown>,
  channel: "email" | "sms",
): Promise<VendorQuoteSenderProof | null> {
  const { data, error } = await db.rpc("read_vendor_quote_sender_authority_revision");
  const read = Array.isArray(data) ? data[0] : data;
  const nowMs = Date.parse(String(read?.evaluated_at ?? ""));
  if (error || !read || !/^\d+$/.test(String(read.revision)) || !Number.isFinite(nowMs)) throw new Error("Sender authority revision unavailable.");
  const context: SenderPolicyReadContext = { db, nowMs, validUntilMs: nowMs + 5_000, workspaceId: "" };
  const sender = await resolveVendorOutreachIdentity(db, String(cap.manager_user_id), String(cap.work_order_id), channel, context);
  if (!sender || !vendorQuoteSenderMatches(sender, cap.sender_snapshot as VendorQuoteSenderIdentity) ||
      sender.mode !== cap.sender_mode || sender.version !== cap.sender_version) return null;
  return { capabilityId: String(cap.id), revision: String(read.revision), evaluatedAt: new Date(nowMs).toISOString(),
    validUntil: new Date(context.validUntilMs).toISOString(), channel, senderKey: vendorQuoteSenderKey(sender), senderSnapshot: sender };
}
