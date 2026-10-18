import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import type { SharedLineRole } from "@/lib/one-number/contracts";
import { refreshPayoutDestinationsCacheFromStripe } from "@/lib/stripe-external-accounts.server";

/**
 * "Payouts are set up to the account ending 4417." The one confirmation text after someone asked for
 * payouts BY TEXT and then finished Stripe's hosted onboarding.
 *
 * It fires from the `account.updated` webhook the moment the account BECOMES payout-ready, and only to
 * a person who asked by text: a payouts link minted for their own phone in the last week
 * (`phone_bound_links`, purpose `payouts`, target = their user id) is the proof. Someone who set up
 * payouts in the app is not texted. The text names the last four only; the number is never stored or
 * sent whole, and nothing here moves money. One text per link, however many times Stripe re-sends.
 */

/** The last four of a person's default payout destination, when the cache has one. */
export async function defaultPayoutLast4(db: SupabaseClient, ownerUserId: string): Promise<string | null> {
  const { data } = await db
    .from("payout_destinations_cache")
    .select("last4, is_default, updated_at")
    .eq("owner_user_id", ownerUserId)
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const raw = (data as { last4?: unknown } | null)?.last4;
  const last4 = typeof raw === "string" ? raw.trim() : "";
  return /^\d{4}$/.test(last4) ? last4 : null;
}

export const PAYOUTS_LINK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function payoutsReadyText(last4: string | null): string {
  return last4 && /^\d{4}$/.test(last4) ? `Payouts are set up to the account ending ${last4}.` : "Payouts are set up.";
}

export type PayoutsReadyResult =
  | { sent: true }
  | { sent: false; reason: "not_asked_by_text" | "no_workspace" | "send_refused" };

export async function textPayoutsReady(
  db: SupabaseClient,
  stripe: Stripe | null,
  input: { userId: string; accountId: string; now?: Date },
): Promise<PayoutsReadyResult> {
  const since = new Date((input.now ?? new Date()).getTime() - PAYOUTS_LINK_WINDOW_MS).toISOString();
  const { data } = await db
    .from("phone_bound_links")
    .select("id, phone_key, workspace_id, target_type")
    .eq("purpose", "payouts")
    .eq("target_id", input.userId)
    .is("revoked_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const link = data as { id?: unknown; phone_key?: unknown; workspace_id?: unknown; target_type?: unknown } | null;
  if (!link?.id || !link.phone_key) return { sent: false, reason: "not_asked_by_text" };
  const workspaceId = String(link.workspace_id ?? "").trim();
  if (!workspaceId) return { sent: false, reason: "no_workspace" };

  let last4: string | null = null;
  if (stripe) {
    const destinations = await refreshPayoutDestinationsCacheFromStripe(stripe, db, input.userId, input.accountId).catch(() => []);
    const preferred = destinations.find((d) => d.default) ?? destinations[0];
    last4 = preferred?.last4 ? String(preferred.last4) : null;
  }
  last4 ??= await defaultPayoutLast4(db, input.userId).catch(() => null);

  const role: SharedLineRole = String(link.target_type) === "vendor" ? "vendor" : "manager";
  const sent = await sendWorkspacePhoneText(db, {
    workspaceId,
    phoneKey: String(link.phone_key),
    body: payoutsReadyText(last4),
    role,
    idempotencyKey: `payouts-ready:${input.accountId}:${String(link.id)}`,
  });
  return sent ? { sent: true } : { sent: false, reason: "send_refused" };
}
