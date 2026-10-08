import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unitPriceCentsForMeter, type CommsBillingMeter } from "@/lib/comms-billing/rates";
import { isNumberSubscriptionEnabled } from "./constants";
import { finishNumberCredit, getNumberCreditBalance, reserveNumberCredit } from "./credit.server";
import { numberServiceEntitled } from "./subscription.server";

/**
 * The vendor side of PropLane Number (docs/agents/comms-billing.md § PropLane Number, vendor-portal.md
 * § Work number). Every function here is a no-op while `NUMBER_SUBSCRIPTION_ENABLED` is off, so the
 * free vendor number behaves exactly as it did before the subscription existed.
 *
 * Money rules kept here, in one place:
 *  - Gate on `numberServiceEntitled` (active | past_due), never on a status string of your own.
 *  - Reserve credit BEFORE the provider or model call; hand it back when nothing was sent.
 *  - A credit read that fails is a refusal, never a free send.
 */
export type VendorNumberRefusal = "subscription_inactive" | "out_of_credit" | "credit_unavailable";

/** Whether vendors must subscribe to hold and use a number (the flag decides, nothing else). */
export function vendorNumberSubscriptionRequired(): boolean {
  return isNumberSubscriptionEnabled();
}

/** True when the vendor may claim, hold and use a number: always while the flag is off. */
export async function vendorNumberEntitled(db: SupabaseClient, vendorUserId: string): Promise<boolean> {
  if (!vendorNumberSubscriptionRequired()) return true;
  return numberServiceEntitled(vendorUserId, db);
}

/**
 * Read-only: could the vendor pay `neededCents` right now? Used to avoid paying a model to write a
 * text that could not be paid for. The reserve below is still the authority.
 */
export async function vendorNumberCreditShortfall(
  db: SupabaseClient,
  vendorUserId: string,
  neededCents: number,
): Promise<VendorNumberRefusal | null> {
  if (!vendorNumberSubscriptionRequired()) return null;
  try {
    if (!(await numberServiceEntitled(vendorUserId, db))) return "subscription_inactive";
    const balance = await getNumberCreditBalance(vendorUserId, db);
    return balance.totalCents < neededCents ? "out_of_credit" : null;
  } catch {
    return "credit_unavailable";
  }
}

export type VendorNumberReservation =
  | { ok: true; reserved: boolean }
  | { ok: false; reason: VendorNumberRefusal };

/**
 * Reserve a meter against the vendor's number credit. `reserved: false` means nothing was debited
 * (the flag is off). A refusal or an error is `ok: false`: the caller sends nothing.
 */
export async function reserveVendorNumberCredit(
  db: SupabaseClient,
  vendorUserId: string,
  meter: CommsBillingMeter,
  quantity: number,
  key: string,
  opts: { allowUnfunded?: boolean; metadata?: Record<string, unknown> } = {},
): Promise<VendorNumberReservation> {
  if (!vendorNumberSubscriptionRequired()) return { ok: true, reserved: false };
  try {
    const result = await reserveNumberCredit(vendorUserId, meter, quantity, key, { db, ...opts });
    if (result.allowed) return { ok: true, reserved: true };
    return { ok: false, reason: result.reason === "subscription_inactive" ? "subscription_inactive" : "out_of_credit" };
  } catch (error) {
    console.error("[vendor number] credit reserve failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, reason: "credit_unavailable" };
  }
}

/** Keep the debit (default) or hand it back. Never throws: the send's own outcome is already decided. */
export async function finishVendorNumberCredit(
  db: SupabaseClient,
  vendorUserId: string,
  key: string,
  opts: { release?: boolean } = {},
): Promise<void> {
  try {
    await finishNumberCredit(vendorUserId, key, { db, release: opts.release === true });
  } catch (error) {
    console.error("[vendor number] credit reconcile failed", { key, release: opts.release === true }, error instanceof Error ? error.message : "unknown");
  }
}

/** Cost in cents of `segments` outbound text segments at the retail rate. */
export function vendorSmsCostCents(segments: number): number {
  return unitPriceCentsForMeter("sms_outbound_segment") * Math.max(1, segments);
}

/** Cost in cents of one AI turn at the retail rate. */
export function vendorAiTurnCostCents(): number {
  return unitPriceCentsForMeter("ai_agent_turn");
}

/** What the vendor reads when a text is refused for the number's billing; any other reason passes through. */
export function vendorNumberRefusalMessage(reason: string | undefined): string | undefined {
  if (reason === "out_of_credit") return "Out of credit. Buy credit in Settings to text from your number.";
  if (reason === "subscription_inactive") return "Subscribe to PropLane Number to text from your number.";
  if (reason === "credit_unavailable") return "Your credit could not be checked right now. Try again.";
  return reason;
}
