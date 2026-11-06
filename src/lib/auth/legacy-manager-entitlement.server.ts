import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { loadAccountPurchaseRows } from "@/lib/manager-purchase-account-rows.server";
import { isManagerOnboardingComplete, type ManagerPurchaseRow } from "@/lib/auth/manager-onboarding";

export class ManagerEntitlementUnavailable extends Error {
  constructor() { super("Could not verify manager account access. Please try again."); }
}

/** Read-only routing evidence; never claims a purchase or grants a role. */
export async function hasVerifiedLegacyManagerEntitlement(db: SupabaseClient, user: User): Promise<boolean> {
  if (!user.email_confirmed_at || !user.email?.trim()) return false;
  const read = await loadAccountPurchaseRows<ManagerPurchaseRow>(db, user.id, "id, email, manager_id, tier, billing, stripe_checkout_session_id, user_id, full_name, paid_at");
  if (read.readFailed) throw new ManagerEntitlementUnavailable();
  const email = user.email.trim().toLowerCase();
  return read.rows.some((row) => row.user_id === null && row.email?.trim().toLowerCase() === email && isManagerOnboardingComplete(row));
}
