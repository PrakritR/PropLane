import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  clearManagerConnectAccountId,
  createAxisConnectAccount,
  persistManagerConnectAccountId,
  retrieveManagerConnectAccountOrNull,
} from "@/lib/stripe-connect";

/** Returns a Connect account id for the given user, creating one or clearing stale ids when
 * needed. Column is generic (keyed by userId only) — reused as-is for vendor payout accounts. */
export async function ensureManagerConnectAccountId(
  stripe: Stripe,
  db: SupabaseClient,
  opts: { userId: string; email?: string; axisPortal?: "portal" | "vendor" },
): Promise<string> {
  const { data: profile } = await db
    .from("profiles")
    .select("stripe_connect_account_id")
    .eq("id", opts.userId)
    .maybeSingle();

  let accountId = profile?.stripe_connect_account_id?.trim() ?? null;

  if (accountId) {
    const existing = await retrieveManagerConnectAccountOrNull(stripe, accountId);
    if (!existing) {
      await clearManagerConnectAccountId(db, opts.userId);
      accountId = null;
    }
  }

  if (!accountId) {
    const account = await createAxisConnectAccount(stripe, {
      email: opts.email,
      axisUserId: opts.userId,
      axisPortal: opts.axisPortal,
    });
    accountId = account.id;
    // Service-role write pinned to this user — `profiles` UPDATE is revoked from
    // `authenticated`, which is what `db` is. See persistManagerConnectAccountId.
    await persistManagerConnectAccountId(opts.userId, accountId);
  }

  return accountId;
}

/** Vendor payout accounts reuse the same profiles.stripe_connect_account_id column — a vendor
 * has one Connect account regardless of how many managers they work with. */
export async function ensureVendorConnectAccountId(
  stripe: Stripe,
  db: SupabaseClient,
  opts: { userId: string; email?: string },
): Promise<string> {
  return ensureManagerConnectAccountId(stripe, db, { ...opts, axisPortal: "vendor" });
}
