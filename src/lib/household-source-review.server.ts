import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A captured resident payment whose PLATFORM allocation refused.
 *
 * The resident's charge rows are already paid when this happens — the settlement ran and
 * `creditVerifiedHouseholdCheckoutSource` (or its manual-bank twin) is a separate,
 * fail-closed step that credits the manager's hold. Every one of its refusals is
 * deliberate, so the money question is "which invariant said no", and the answer used to
 * live only in a `console.error`: the verify route reported one generic sentence, the
 * webhook retried the SAME inputs and gave up after Stripe's retry window, and nothing was
 * left to find the payment by.
 *
 * One `audit_log` row per source id carries that answer: `landlord_id` names the manager
 * whose hold is missing, `result_summary.reason` is the actual refusal, and `dedupe_key`
 * makes the verify route, the webhook and every retry collapse into the one row. It is a
 * record, never a credit — the allocation itself stays with the idempotent RPC, so this
 * cannot double-credit anything.
 *
 * Read by the admin Health page (`loadAdminHealth`, group `payments`).
 */
export const HOUSEHOLD_SOURCE_REVIEW_ACTION = "household_source_review";

/**
 * Where the refusal was seen. The webhook surfaces matter most: ACH clears days after the
 * resident left, and off-session autopay rent has no interactive verify path at all, so
 * those credits are the ones nobody is watching.
 */
export type HouseholdSourceReviewSurface =
  | "checkout_verify"
  | "manual_ach_verify"
  | "webhook"
  | "webhook_manual_ach"
  | "webhook_autopay"
  | "autopay_runner"
  | "hold_release";

/**
 * WHICH half of the money move needs the person.
 *
 * `credit` is the serious one: the capture settled but the manager's hold was never
 * created, so the money has no allocation. `release` means the hold EXISTS and is
 * correct — only paying it out refused (an unlinked or mismatched Connect account, a
 * transient provider error), so the hold stays `classified_held` and the next release
 * attempt picks it up. Keeping them apart stops a payout problem from reading as missing
 * money, and stops either from suppressing the other's row.
 */
export type HouseholdSourceReviewStage = "credit" | "release";

/** The reason string as stored: one line, bounded, never a stack trace. */
export const HOUSEHOLD_SOURCE_REVIEW_REASON_MAX_CHARS = 300;

export function householdSourceReviewDedupeKey(
  sourceId: string,
  stage: HouseholdSourceReviewStage = "credit",
): string {
  const suffix = stage === "credit" ? "" : `${stage}:`;
  return `${HOUSEHOLD_SOURCE_REVIEW_ACTION}:${suffix}${sourceId.trim()}`;
}

/** The charge ids a household source's metadata names, in the order it names them. */
export function householdChargeIdsFromMetadata(
  metadata: { charge_ids?: string | null; charge_id?: string | null } | null | undefined,
): string[] {
  return (metadata?.charge_ids || metadata?.charge_id || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function householdSourceReviewReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const line = raw.replace(/\s+/g, " ").trim();
  return (line || "The payment source could not be credited.").slice(
    0,
    HOUSEHOLD_SOURCE_REVIEW_REASON_MAX_CHARS,
  );
}

/**
 * Record that one captured source needs review. Best effort by design: the caller has
 * already taken the resident's money and must answer them, so a failure to write the trace
 * is logged and swallowed rather than turned into a refusal of a settled payment.
 */
export async function recordHouseholdSourceReviewNeeded(
  db: SupabaseClient,
  input: {
    /** The manager whose hold is missing. Without one there is no account to file this under. */
    ownerManagerUserId: string | null | undefined;
    /** Checkout session id, or the PaymentIntent id for a manual bank payment. */
    sourceId: string;
    paymentIntentId?: string | null;
    chargeIds?: readonly string[];
    /** Which path saw it, so staff know where to look. */
    surface: HouseholdSourceReviewSurface;
    /** Defaults to the credit itself — the case where the money has no allocation. */
    stage?: HouseholdSourceReviewStage;
    error: unknown;
  },
): Promise<{ recorded: boolean; reason: string }> {
  const reason = householdSourceReviewReason(input.error);
  const stage = input.stage ?? "credit";
  const ownerUserId = input.ownerManagerUserId?.trim() ?? "";
  const sourceId = input.sourceId.trim();
  // Logged here, once, for every filed review: the row is what staff find later, the log
  // line is what a tail of the deploy shows while it is happening.
  console.error("[household source review]", { stage, surface: input.surface, sourceId, reason });
  if (!ownerUserId || !sourceId) {
    console.error("[household source review] cannot file without an owner and a source", {
      surface: input.surface,
      reason,
    });
    return { recorded: false, reason };
  }
  try {
    const { error } = await db.from("audit_log").insert({
      actor_user_id: ownerUserId,
      landlord_id: ownerUserId,
      action: HOUSEHOLD_SOURCE_REVIEW_ACTION,
      tool_name: null,
      input_summary: {
        sourceId,
        paymentIntentId: input.paymentIntentId?.trim() || null,
        chargeIds: [...(input.chargeIds ?? [])],
        surface: input.surface,
        stage,
      },
      result_summary: { reason },
      dedupe_key: householdSourceReviewDedupeKey(sourceId, stage),
      created_at: new Date().toISOString(),
    });
    // A duplicate key is the success case on a retry: the source is already filed.
    if (error && !isDuplicateKey(error)) {
      console.error("[household source review] could not file the review row", error, { sourceId, reason });
      return { recorded: false, reason };
    }
    return { recorded: true, reason };
  } catch (e) {
    // The caller has already taken the resident's money and owes them an answer: a trace
    // that cannot be written is never allowed to become a 500 over a settled payment.
    console.error("[household source review] could not file the review row", e, { sourceId, reason });
    return { recorded: false, reason };
  }
}

function isDuplicateKey(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === "23505" || /duplicate key|already exists/i.test(error.message ?? "");
}

/**
 * Run a platform credit and, if it refuses, file the trace before letting the error through.
 *
 * Every `creditVerifiedHousehold*Source` call on a non-interactive path goes through this
 * instead of its own try/catch, so the pairing lives in ONE place and a credit path added
 * later cannot quietly ship without a trace. The error is rethrown unchanged: the webhook
 * must still answer 500 so Stripe retries, and the dedupe key makes the extra files during
 * those retries collapse into the one row.
 */
export async function creditOrFileHouseholdSourceReview<T>(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string | null | undefined;
    sourceId: string;
    paymentIntentId?: string | null;
    chargeIds?: readonly string[];
    surface: HouseholdSourceReviewSurface;
  },
  credit: () => Promise<T>,
): Promise<T> {
  try {
    return await credit();
  } catch (error) {
    await recordHouseholdSourceReviewNeeded(db, { ...input, error });
    throw error;
  }
}
