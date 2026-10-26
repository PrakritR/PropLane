import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";

/**
 * Where a manager's message credit comes from.
 *
 * A Free manager who holds the standalone PropLane Number add-on ($5/month + usage,
 * `number_subscriptions` owner_role `manager`, entitled = active | past_due) has an empty workspace
 * wallet and no plan credit; their sends spend the SUBSCRIPTION's credit ($3 included each UTC month,
 * then bought credit) through the same `reserveNumberCredit` / `finishNumberCredit` /
 * `settleNumberCreditQuantity` triple the vendor and resident numbers use. Everybody else (Pro /
 * Business plan credit, a Free manager without the add-on, a lapsed add-on) is untouched and stays on
 * the workspace wallet / messaging-credit pool.
 *
 * The source is decided ONCE per reservation key: a key that already has a number-credit event is
 * `number`, one that already has a wallet/pool event is `wallet`, and only a brand-new key consults
 * the entitlement. So reserve, settle and refund can never land on different ledgers, even if the
 * add-on lapses or is bought between them.
 */
export type ManagerCreditSource = "wallet" | "number";

/**
 * Entitlement only: does this manager's NEW usage draw from the number subscription? `via: "add_on"`
 * means no Pro/Business plan covers them (`managerPersonalNumberEntitlement` reads the plan through
 * `getEffectiveManagerSkuTier`) AND the add-on is entitled. An unreadable plan or subscription is
 * `wallet`: the existing behaviour, never a free send.
 */
export async function managerNewUsageCreditSource(db: SupabaseClient, managerUserId: string): Promise<ManagerCreditSource> {
  return (await managerCreditEntitlement(db, managerUserId)).source;
}

/**
 * `source` for NEW usage, plus `mayHaveNumberHistory`: true only for a manager with no plan credit
 * and no entitled add-on (Free, or a lapsed add-on), the one case where an earlier reservation could
 * still live on the number ledger. Plan-covered and unreadable-plan managers never look it up, so
 * the common send path adds no query.
 */
export async function managerCreditEntitlement(
  db: SupabaseClient,
  managerUserId: string,
): Promise<{ source: ManagerCreditSource; mayHaveNumberHistory: boolean }> {
  const id = managerUserId.trim();
  if (!id) return { source: "wallet", mayHaveNumberHistory: false };
  try {
    const { managerPersonalNumberEntitlement } = await import("@/lib/one-number/personal-number-entitlement.server");
    const entitlement = await managerPersonalNumberEntitlement(db, id);
    if (!entitlement.ok) return { source: "wallet", mayHaveNumberHistory: false };
    if (entitlement.entitled) {
      return entitlement.via === "add_on"
        ? { source: "number", mayHaveNumberHistory: true }
        : { source: "wallet", mayHaveNumberHistory: false };
    }
    return { source: "wallet", mayHaveNumberHistory: true };
  } catch {
    return { source: "wallet", mayHaveNumberHistory: false };
  }
}

/**
 * The ledger an existing reservation key lives on, or `null` when neither has it. A failed read
 * throws: guessing the ledger could settle or refund the wrong one. The ONE exception is a database
 * that has no number ledger at all (the table or column is missing, code ahead of
 * `20261008200000_number_subscriptions`): no reservation can live on a ledger that does not exist,
 * so that reads as `null` and every settle keeps working on the wallet, exactly as it did before.
 */
export async function existingCreditSourceForKey(
  db: SupabaseClient,
  managerUserId: string,
  key: string,
): Promise<ManagerCreditSource | null> {
  const numberRow = await db
    .from("number_credit_usage_events")
    .select("idempotency_key")
    .eq("owner_user_id", managerUserId)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (numberRow.error) {
    if (!isMissingSchemaError(numberRow.error)) throw new Error("Communication credit source could not be verified.");
    return null;
  }
  if (numberRow.data) return "number";
  return null;
}

/** Source for a reserve: an existing key keeps its ledger; a new key follows the entitlement. */
export async function creditSourceForReserve(
  db: SupabaseClient,
  managerUserId: string,
  key: string,
): Promise<ManagerCreditSource> {
  const { source, mayHaveNumberHistory } = await managerCreditEntitlement(db, managerUserId);
  if (!mayHaveNumberHistory) return source;
  // A key already on the number ledger replays there (even if the add-on has since lapsed), never
  // as a second debit on the wallet.
  if ((await existingCreditSourceForKey(db, managerUserId, key)) === "number") return "number";
  if (source === "wallet") return "wallet";
  // Entitled, new to the number ledger: a key already reserved on the wallet/pool keeps that ledger.
  const wallet = await db
    .from("manager_comms_usage_events")
    .select("idempotency_key")
    .eq("manager_user_id", managerUserId)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (wallet.error) throw new Error("Communication credit source could not be verified.");
  return wallet.data ? "wallet" : "number";
}

/** Source for a finish / settle / refund: wherever the reservation was made, else the wallet. */
export async function creditSourceForExistingReservation(
  db: SupabaseClient,
  managerUserId: string,
  key: string,
): Promise<ManagerCreditSource> {
  return (await existingCreditSourceForKey(db, managerUserId, key)) ?? "wallet";
}
