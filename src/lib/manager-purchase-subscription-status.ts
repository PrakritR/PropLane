/**
 * `manager_purchases.subscription_status` is read by the managed view-only lock (a trialing Stripe subscription is not
 * a self-paid plan), and it is written by checkout fulfillment, the subscription webhook and the plan reconciler -
 * paths that must not break when the column is not there yet.
 *
 * The column arrives in migration 20261020130000, which is applied before the deploy to each rung. If code ever runs
 * ahead of it anyway, PostgREST answers "column not found" (PGRST204, or 42703 from Postgres) and the whole patch is
 * refused: every manager checkout fulfillment and every subscription webhook delivery would 500, and the reconciler
 * would silently stop recording tiers and cancellations. So one retry drops the status and writes the rest, loudly.
 */

const MISSING_COLUMN_CODES = new Set(["PGRST204", "42703"]);
const STATUS_COLUMN = "subscription_status";

type WriteError = { code?: string | null; message?: string | null } | null;

export function isMissingSubscriptionStatusColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (MISSING_COLUMN_CODES.has(String(e.code ?? ""))) return true;
  const message = String(e.message ?? "");
  return message.includes(STATUS_COLUMN) && /column/i.test(message);
}

/**
 * Run a `manager_purchases` write, and if the only thing wrong with it is the missing status column, run it again
 * without that key. `run` is given the patch to write so the caller keeps its own filters.
 */
export async function writeManagerPurchasePatch<T extends { error: WriteError }>(
  patch: Record<string, unknown>,
  run: (patch: Record<string, unknown>) => PromiseLike<T>,
): Promise<T> {
  const first = await run(patch);
  if (!first.error || !(STATUS_COLUMN in patch) || !isMissingSubscriptionStatusColumn(first.error)) return first;
  const withoutStatus = { ...patch };
  delete withoutStatus[STATUS_COLUMN];
  console.error("[manager-purchases] subscription_status is missing; writing the rest and leaving the plan lock to the migration", {
    message: first.error.message ?? "unknown",
  });
  return run(withoutStatus);
}
