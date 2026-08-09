import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/** Controller config for manager recipient accounts (destination charges; platform collects). */
export const AXIS_CONNECT_CONTROLLER = {
  fees: { payer: "application" as const },
  losses: { payments: "application" as const },
  requirement_collection: "stripe" as const,
  stripe_dashboard: { type: "express" as const },
};

export type ManagerConnectValidation =
  | { ok: true; accountId: string }
  | { ok: false; code: "NO_ACCOUNT" | "TRANSFERS_NOT_ACTIVE"; error: string };

export function connectAccountTransfersActive(account: Stripe.Account): boolean {
  return account.capabilities?.transfers === "active";
}

export function isStripeConnectAccountAccessError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("does not have access to account") || m.includes("that account does not exist");
}

export function managerConnectReconnectMessage(): string {
  return "Your Stripe payout account was created under a different PropLane Stripe setup. Open Portal → Payments and complete Stripe payout setup again.";
}

/** True when the manager can receive ACH destination transfers and withdraw to their bank. */
export function connectAccountReadyForAchPayouts(account: Stripe.Account): boolean {
  return connectAccountTransfersActive(account) && Boolean(account.payouts_enabled);
}

export async function createAxisConnectAccount(
  stripe: Stripe,
  opts: { email?: string; axisUserId: string; axisPortal?: "portal" | "vendor" },
): Promise<Stripe.Account> {
  return stripe.accounts.create({
    country: "US",
    email: opts.email,
    // Destination charges only require transfers on the connected account (not card_payments).
    capabilities: {
      transfers: { requested: true },
    },
    controller: AXIS_CONNECT_CONTROLLER,
    metadata: {
      axis_user_id: opts.axisUserId,
      axis_portal: opts.axisPortal ?? "portal",
    },
  });
}

/** Request transfers on legacy accounts that were created without it. */
export async function ensureConnectAccountTransfersRequested(
  stripe: Stripe,
  accountId: string,
): Promise<Stripe.Account> {
  const account = await stripe.accounts.retrieve(accountId);
  const transfers = account.capabilities?.transfers;
  if (transfers === "active" || transfers === "pending") return account;

  return stripe.accounts.update(accountId, {
    capabilities: {
      transfers: { requested: true },
    },
  });
}

export function managerConnectValidationError(account: Stripe.Account): string {
  const transfers = account.capabilities?.transfers ?? "not_requested";
  if (transfers === "pending") {
    return "This property manager's payout setup is still processing. They must finish Stripe onboarding in Portal → Payments before bank payments can go through.";
  }
  if (transfers === "inactive") {
    return "This property manager's Stripe payout account needs additional information. They must complete onboarding in Portal → Payments before bank payments can go through.";
  }
  return "This property manager has not finished Stripe payout setup. They must connect payouts in Portal → Payments before bank payments can go through.";
}

export async function validateManagerConnectForDestinationCharge(
  stripe: Stripe,
  accountId: string,
): Promise<ManagerConnectValidation> {
  const id = accountId.trim();
  if (!id) {
    return { ok: false, code: "NO_ACCOUNT", error: "No Stripe Connect account linked." };
  }

  const account = await ensureConnectAccountTransfersRequested(stripe, id).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isStripeConnectAccountAccessError(message)) {
      return null;
    }
    throw error;
  });

  if (!account) {
    return {
      ok: false,
      code: "NO_ACCOUNT",
      error: managerConnectReconnectMessage(),
    };
  }

  if (connectAccountTransfersActive(account)) {
    return { ok: true, accountId: account.id };
  }

  return {
    ok: false,
    code: "TRANSFERS_NOT_ACTIVE",
    error: managerConnectValidationError(account),
  };
}

export async function retrieveManagerConnectAccountOrNull(
  stripe: Stripe,
  accountId: string,
): Promise<Stripe.Account | null> {
  const id = accountId.trim();
  if (!id) return null;
  try {
    return await stripe.accounts.retrieve(id);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (isStripeConnectAccountAccessError(message)) return null;
    throw error;
  }
}

/**
 * Writes `profiles.stripe_connect_account_id` with the SERVICE-ROLE client, always
 * pinned to one user id.
 *
 * `20260722123000_lock_role_grant_surface.sql` revoked INSERT/UPDATE/DELETE on
 * `profiles` from `anon` AND `authenticated`. Every caller here hands in the
 * user-scoped server client, which IS `authenticated` — so these writes were
 * silently denied, and because the result was never inspected the failure was
 * invisible. The visible symptom was severe: a manager could complete the whole
 * Stripe Connect onboarding, and PropLane would still report "has not connected
 * Stripe payouts yet", because the account id it had just created was never
 * stored. That made the application fee unpayable for every new manager.
 *
 * This is the shape AGENTS.md prescribes for a self-service profile write:
 * authorize the session in the route, then write service-role pinned to
 * `user.id`. The `db` argument is deliberately ignored for the write.
 */
async function writeConnectAccountId(managerUserId: string, accountId: string | null): Promise<void> {
  const id = managerUserId.trim();
  if (!id) return;
  const service = createSupabaseServiceRoleClient();
  const { error } = await service
    .from("profiles")
    .update({
      stripe_connect_account_id: accountId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  // Surfaced rather than swallowed: losing this write strands a manager who has
  // finished Stripe onboarding in a permanently "not connected" state.
  if (error) throw new Error(`Failed to persist Stripe Connect account id: ${error.message}`);
}

export async function persistManagerConnectAccountId(
  managerUserId: string,
  accountId: string,
): Promise<void> {
  await writeConnectAccountId(managerUserId, accountId);
}

export async function clearManagerConnectAccountId(
  _db: SupabaseClient,
  managerUserId: string,
): Promise<void> {
  await writeConnectAccountId(managerUserId, null);
}

/** Clears a stale Connect account id when the platform key cannot access it, then returns a fresh id or null. */
export async function resolveOrResetManagerConnectAccountId(
  stripe: Stripe,
  db: SupabaseClient,
  managerUserId: string,
): Promise<string | null> {
  const accountId = await resolveManagerConnectAccountId(db, managerUserId);
  if (!accountId) return null;
  const account = await retrieveManagerConnectAccountOrNull(stripe, accountId);
  if (account) return account.id;
  await clearManagerConnectAccountId(db, managerUserId);
  return null;
}

export async function resolveManagerConnectAccountId(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string | null> {
  const id = managerUserId.trim();
  if (!id) return null;
  const { data: profile } = await db
    .from("profiles")
    .select("stripe_connect_account_id")
    .eq("id", id)
    .maybeSingle();
  return (profile as { stripe_connect_account_id?: string | null } | null)?.stripe_connect_account_id?.trim() ?? null;
}

export async function resolveAndValidateManagerConnectForPayments(
  stripe: Stripe,
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerConnectValidation> {
  const accountId = await resolveManagerConnectAccountId(db, managerUserId);
  if (!accountId) {
    return {
      ok: false,
      code: "NO_ACCOUNT",
      error:
        "This property manager has not connected Stripe payouts yet. Use Zelle or Venmo if the listing offers it.",
    };
  }
  const result = await validateManagerConnectForDestinationCharge(stripe, accountId);
  if (!result.ok && result.code === "NO_ACCOUNT") {
    await clearManagerConnectAccountId(db, managerUserId);
  }
  return result;
}
