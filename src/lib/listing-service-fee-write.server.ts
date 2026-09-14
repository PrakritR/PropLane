import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { persistListingServiceFeePayer, type ServiceFeePayer } from "@/lib/payment-policy";
import {
  listingPaymentWaiverCodeMatchesServer,
  waiverGrantedFromPromoCodeServer,
} from "@/lib/payment-policy.server";

/**
 * Re-derive a listing's processing-fee setting on every write.
 *
 * The browser decides nothing here. A coverage code is a credential, and one of
 * them was verifiably readable in a client chunk — so a manager could post a
 * listing claiming `serviceFeePayer:"proplane"` with that code and have PropLane
 * absorb Stripe's cost on every resident payment for that listing, indefinitely,
 * with no grant row anywhere. The write path used to store the submission
 * exactly as sent, which made the client's own claim the only check there was.
 *
 * The rule is the same one `persistListingServiceFeePayer` has always
 * described; the difference is that the verdict now comes from the server's
 * code list and the account's real grant, not from the payload.
 *
 * A property whose owner cannot be resolved is left untouched rather than
 * rewritten — that is an attribution problem for the caller above to answer,
 * and guessing here would be a second place deciding who pays.
 */
export async function reconcileListingServiceFeeOnWrite(
  db: SupabaseClient,
  input: { ownerUserId: string | null; rowData: unknown; propertyData: unknown },
): Promise<{ rowData: unknown; propertyData: unknown }> {
  const { ownerUserId, rowData, propertyData } = input;
  if (!ownerUserId) return { rowData, propertyData };

  const rowSubmission = readSubmission(rowData, "submission");
  const propertySubmission = readSubmission(propertyData, "listingSubmission");
  if (!rowSubmission && !propertySubmission) return { rowData, propertyData };

  const claimed = (propertySubmission ?? rowSubmission)!;
  const claimedPayer = claimed.serviceFeePayer as ServiceFeePayer | null | undefined;
  const claimedCode = typeof claimed.serviceFeeWaiverCode === "string" ? claimed.serviceFeeWaiverCode : undefined;

  // Only a `proplane` claim can cost PropLane money, so only that needs the
  // round trip. Everything else is stored as the manager chose it.
  if (claimedPayer !== "proplane") return { rowData, propertyData };

  const purchase = await getManagerPurchaseSku(ownerUserId);
  if (purchase.readFailed) {
    // A failed read is not evidence of a grant. Refuse the upgrade rather than
    // spend PropLane's money on an unverified claim.
    return {
      rowData: patchSubmission(rowData, "submission", { serviceFeePayer: "resident", serviceFeeWaiverCode: undefined }),
      propertyData: patchSubmission(propertyData, "listingSubmission", {
        serviceFeePayer: "resident",
        serviceFeeWaiverCode: undefined,
      }),
    };
  }

  const accountGranted = waiverGrantedFromPromoCodeServer(purchase.promoCode);
  const codeMatches = listingPaymentWaiverCodeMatchesServer(claimedCode);
  const resolved = persistListingServiceFeePayer(claimedPayer, claimedCode, accountGranted, codeMatches);

  return {
    rowData: patchSubmission(rowData, "submission", resolved),
    propertyData: patchSubmission(propertyData, "listingSubmission", resolved),
  };
}

function readSubmission(container: unknown, key: string): Record<string, unknown> | null {
  if (!container || typeof container !== "object" || Array.isArray(container)) return null;
  const submission = (container as Record<string, unknown>)[key];
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) return null;
  return submission as Record<string, unknown>;
}

function patchSubmission(
  container: unknown,
  key: string,
  next: { serviceFeePayer: ServiceFeePayer | null; serviceFeeWaiverCode?: string },
): unknown {
  const submission = readSubmission(container, key);
  if (!submission) return container;
  const patched: Record<string, unknown> = { ...submission, serviceFeePayer: next.serviceFeePayer };
  if (next.serviceFeeWaiverCode) patched.serviceFeeWaiverCode = next.serviceFeeWaiverCode;
  else delete patched.serviceFeeWaiverCode;
  return { ...(container as Record<string, unknown>), [key]: patched };
}
