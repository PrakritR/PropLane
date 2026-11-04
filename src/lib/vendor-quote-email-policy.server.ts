import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Recipient-wide suppression intentionally survives sender/workspace revisions.
 * This matches the public quote projection and never authorizes initial outreach. */
export async function canSendVendorQuoteEmail(db: SupabaseClient, recipientEmail: string): Promise<boolean> {
  const email = recipientEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  try {
    const { data, error } = await db.from("vendor_quote_email_permissions")
      .select("id").eq("normalized_email", email)
      .in("evidence_kind", ["recipient_withdrawal", "hard_bounce", "complaint"])
      .eq("active", true).limit(1);
    return !error && Array.isArray(data) && data.length === 0;
  } catch { return false; }
}
