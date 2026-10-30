import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Claim once; retries by the same verified user may complete interrupted provisioning. */
export async function claimManagerPurchase(db: SupabaseClient, purchaseId: string, userId: string): Promise<boolean> {
  const claimed = await db.from("manager_purchases").update({ user_id: userId }).eq("id", purchaseId).is("user_id", null).select("id").maybeSingle();
  if (claimed.error) throw claimed.error;
  if (claimed.data) return true;
  const existing = await db.from("manager_purchases").select("user_id").eq("id", purchaseId).maybeSingle();
  if (existing.error) throw existing.error;
  return existing.data?.user_id === userId;
}
