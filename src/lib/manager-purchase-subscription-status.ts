/**
 * `manager_purchases.subscription_status` is read by the managed view-only lock (a trialing Stripe subscription is not
 * a self-paid plan), and it is written by checkout fulfillment, the subscription webhook and the plan reconciler -
 * paths that must not break when the column is not there yet. `first_paid_at` (migration 20261020140000: the lock's
proof that money actually moved) is handled the same way.
 *
 * The column arrives in migration 20261020130000, which is applied before the deploy to each rung. If code ever runs
 * ahead of it anyway, PostgREST answers "column not found" (PGRST204, or 42703 from Postgres) and the whole patch is
 * refused: every manager checkout fulfillment and every subscription webhook delivery would 500, and the reconciler
 * would silently stop recording tiers and cancellations. So one retry drops the status and writes the rest, loudly.
 */

const MISSING_COLUMN_CODES = new Set(["PGRST204", "42703"]);
const STATUS_COLUMN = "subscription_status";
/** Columns newer than the code that writes them: dropped from a patch (one at a time) when the database lacks them. */
const OPTIONAL_COLUMNS = [STATUS_COLUMN, "first_paid_at"] as const;

type WriteError = { code?: string | null; message?: string | null } | null;

function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (MISSING_COLUMN_CODES.has(String(e.code ?? ""))) return true;
  const message = String(e.message ?? "");
  return /column/i.test(message) && OPTIONAL_COLUMNS.some((c) => message.includes(c));
}

export function isMissingSubscriptionStatusColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (MISSING_COLUMN_CODES.has(String(e.code ?? ""))) return true;
  const message = String(e.message ?? "");
  return message.includes(STATUS_COLUMN) && /column/i.test(message);
}

export function isMissingFirstPaidColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  const message = String(e.message ?? "");
  return message.includes("first_paid_at") && (MISSING_COLUMN_CODES.has(String(e.code ?? "")) || /column/i.test(message));
}

/**
 * Run a `manager_purchases` write, and if the only thing wrong with it is a missing optional column, run it again
 * without that key (up to once per optional column). `run` is given the patch to write so the caller keeps its own
 * filters.
 */
export async function writeManagerPurchasePatch<T extends { error: WriteError }>(
  patch: Record<string, unknown>,
  run: (patch: Record<string, unknown>) => PromiseLike<T>,
): Promise<T> {
  let current = patch;
  let result = await run(current);
  for (let attempt = 0; attempt < OPTIONAL_COLUMNS.length; attempt += 1) {
    if (!result.error) return result;
    const present = OPTIONAL_COLUMNS.filter((c) => c in current);
    if (present.length === 0 || !isMissingColumnError(result.error)) return result;
    // Drop the column the error names; a bare code (no column named) drops the first optional one present.
    const message = String(result.error.message ?? "");
    const named = present.find((c) => message.includes(c)) ?? present[0]!;
    const next = { ...current };
    delete next[named];
    console.error(`[manager-purchases] ${named} is missing; writing the rest and leaving the plan lock to the migration`, {
      message: result.error.message ?? "unknown",
    });
    current = next;
    result = await run(current);
  }
  return result;
}

type FirstPaidDb = {
  from: (table: "manager_purchases") => {
    update: (patch: Record<string, unknown>) => {
      is: (column: string, value: null) => {
        eq: (column: string, value: string) => PromiseLike<{ error: WriteError }>;
      };
    };
  };
};

/**
 * Stamp `manager_purchases.first_paid_at` (only while it is still null) on the row matched by `column = value`.
 * It is the lock's evidence that money actually moved, so callers pass it only for a positive `amount_paid`
 * invoice / a paid, positive `amount_total` session. A database without the column logs and moves on (the lock
 * then stays closed, which is the safe direction); any other error is thrown so a webhook is retried.
 */
export async function markManagerPurchaseFirstPaid(
  db: unknown,
  match: { column: "id" | "user_id" | "stripe_subscription_id"; value: string },
  at: Date = new Date(),
): Promise<void> {
  const value = match.value.trim();
  if (!value) return;
  const { error } = await (db as FirstPaidDb)
    .from("manager_purchases")
    .update({ first_paid_at: at.toISOString() })
    .is("first_paid_at", null)
    .eq(match.column, value);
  if (!error) return;
  if (isMissingFirstPaidColumn(error)) {
    console.error("[manager-purchases] first_paid_at is missing; the plan lock stays closed until the migration is applied", {
      message: error.message ?? "unknown",
    });
    return;
  }
  throw new Error(error.message || "Could not record the first payment.");
}
