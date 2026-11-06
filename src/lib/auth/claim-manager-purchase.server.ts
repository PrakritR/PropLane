import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Claim the exact verified purchase; same-subject retries may finish provisioning. */
export async function claimManagerPurchase(
  db: SupabaseClient,
  purchaseId: string,
  userId: string,
  expected: { email: string; managerId: string; sessionId: string },
): Promise<boolean> {
  const claimed = await db.from("manager_purchases").update({ user_id: userId })
    .eq("id", purchaseId).eq("email", expected.email).eq("manager_id", expected.managerId)
    .eq("stripe_checkout_session_id", expected.sessionId).is("user_id", null).select("id").maybeSingle();
  if (claimed.error) throw claimed.error;
  if (claimed.data) return true;
  const existing = await db.from("manager_purchases").select("user_id")
    .eq("id", purchaseId).eq("email", expected.email).eq("manager_id", expected.managerId)
    .eq("stripe_checkout_session_id", expected.sessionId).maybeSingle();
  if (existing.error) throw existing.error;
  return existing.data?.user_id === userId;
}
