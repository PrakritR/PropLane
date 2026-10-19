/**
 * Context for the vendor flow on the PropLane line (W24). Built by the inbound SMS handler from the number that
 * texted, never from model or sender input. Its own type, so no manager, resident, vendor-portal or leasing tool can
 * typecheck into the registry that binds to it (AGENTS.md: one registry + resolver + route per role).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type VendorLineContext = {
  kind: "vendor_line";
  /** The platform service owner whose line (or the shared line) was texted. Scope key for history. */
  landlordId: string;
  db: SupabaseClient;
  /** The texter (E.164). Untrusted as an identity; addresses the reply. */
  senderPhone: string;
  /** The vendor account whose VERIFIED phone this is, or null for a stranger. Read from the profile, never the text. */
  vendorUserId: string | null;
};

export function buildVendorLineContext(
  db: SupabaseClient,
  args: Omit<VendorLineContext, "kind" | "db">,
): VendorLineContext {
  return { kind: "vendor_line", db, ...args };
}
