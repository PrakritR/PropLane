import type { SupabaseClient } from "@supabase/supabase-js";

/** A paid unclaimed checkout needs its explicit verified claim, never a new free row. */
export async function hasUnlinkedPaidManagerPurchase(db: SupabaseClient, userId: string, email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  // PostgREST treats * as a wildcard even after LIKE escaping.
  if (!normalized || normalized.includes("*")) throw new Error("Manager purchase requires review.");
  const lookup = await db.auth.admin.getUserById(userId);
  if (lookup.error || !lookup.data?.user?.email_confirmed_at || lookup.data.user.email?.trim().toLowerCase() !== normalized) throw new Error("Manager purchase requires verified email.");
  const pattern = normalized.replace(/[\\%_]/g, "\\$&");
  const { data, error } = await db.from("manager_purchases").select("id,email,stripe_checkout_session_id")
    .ilike("email", pattern).is("user_id", null).not("paid_at", "is", null).like("stripe_checkout_session_id", "cs\\_%").limit(10);
  if (error) throw new Error("Manager purchase requires review.");
  return (data ?? []).some((row) => typeof row.email === "string" && row.email.trim().toLowerCase() === normalized && typeof row.stripe_checkout_session_id === "string" && row.stripe_checkout_session_id.startsWith("cs_"));
}
