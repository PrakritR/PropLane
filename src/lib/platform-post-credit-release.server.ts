import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { releaseVerifiedPlatformHoldsForOwner } from "@/lib/platform-hold-release.server";
import { settleClearedPlatformOwnerRecovery } from "@/lib/platform-owner-recovery.server";
import { recordHouseholdSourceReviewNeeded } from "@/lib/household-source-review.server";

/**
 * Everything that happens AFTER a credit RPC has committed.
 *
 * The credit is the money: once that transaction returns a hold id, the manager has been
 * allocated their share and the payer's payment is done. Paying it out is a separate, later
 * job — `releaseVerifiedPlatformHoldsForOwner` has to resolve a Connect destination, and it
 * fail-closes on anything it cannot prove (an account whose `metadata.axis_user_id` does not
 * match its owner, a concurrent transfer, a transient provider error). Letting that throw
 * back to the caller was the browser-proof 409: a successful, already-credited payment was
 * reported to the payer as needing review, and the webhook's retries re-ran the same refusal
 * until Stripe gave up. In the application-fee flow the same throw also skipped the
 * promotion, orphan report and setup email that follow the fulfil call.
 *
 * So this never throws. The hold stays `classified_held`, which is exactly the state the
 * next release pass picks up (`account.updated` when the owner links or fixes their bank,
 * and the reconcile cron), and the reason is filed as a `release`-stage review so a payout
 * stuck on a person is findable without being mistaken for missing money.
 *
 * Every post-credit release goes through here — the guard in
 * `tests/unit/household-source-review-trace.test.ts` fails a new direct call. A release
 * that IS the operation being requested (a vendor invoice payout, a work-order payout) is
 * not this: there the caller asked for the transfer and must hear that it refused.
 */
export async function releaseCreditedHoldAfterCommit(
  db: SupabaseClient,
  stripe: Stripe,
  input: {
    ownerUserId: string;
    holdId: string;
    /** Checkout session id, or the PaymentIntent id when the PI is the source key. */
    sourceId: string;
    paymentIntentId: string;
    chargeIds: readonly string[];
    /**
     * Whether the owner's debt recovery settles first. Only the paths that credited through
     * `credit_platform_income_with_recovery` have anything to settle.
     */
    settleRecovery?: boolean;
  },
): Promise<void> {
  try {
    if (input.settleRecovery !== false) {
      await settleClearedPlatformOwnerRecovery(db, stripe, {
        ownerUserId: input.ownerUserId, holdId: input.holdId,
      });
    }
    await releaseVerifiedPlatformHoldsForOwner(db, {
      ownerUserId: input.ownerUserId, holdId: input.holdId, stripe,
    });
  } catch (error) {
    await recordHouseholdSourceReviewNeeded(db, {
      ownerManagerUserId: input.ownerUserId,
      sourceId: input.sourceId,
      paymentIntentId: input.paymentIntentId,
      chargeIds: input.chargeIds,
      surface: "hold_release",
      stage: "release",
      error,
    });
  }
}
