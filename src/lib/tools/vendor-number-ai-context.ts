/**
 * Context for the answer-only AI on a vendor's PropLane number. Built by the
 * inbound SMS handler from the number that was TEXTED (the vendor is whoever
 * owns that number), never from model or sender input. Its own type, so none of
 * the manager, resident, vendor-portal or leasing tools can typecheck into the
 * registry that binds to it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorDeliveryProvider } from "@/lib/vendor-work-identity-delivery.server";

export type VendorNumberAiContext = {
  kind: "vendor_number_ai";
  /** The vendor's own user id: the only scope key every tool applies. */
  vendorUserId: string;
  /** audit/trace scope column value (same as the vendor's user id). */
  landlordId: string;
  /** Service-role client: every query built from it MUST be pinned to `vendorUserId`. */
  db: SupabaseClient;
  /** The texter (E.164). Untrusted as an identity; used only to address the reply and the handoff. */
  senderPhone: string;
  senderText: string;
  messageSid: string;
  /** Whether the vendor wants texts forwarded to their verified phone. */
  forwardToPhone: boolean;
  provider: VendorDeliveryProvider;
  now?: Date;
};

export function buildVendorNumberAiContext(
  db: SupabaseClient,
  args: Omit<VendorNumberAiContext, "kind" | "landlordId" | "db">,
): VendorNumberAiContext {
  return { kind: "vendor_number_ai", landlordId: args.vendorUserId, db, ...args };
}
