import { isValidWaiverCodeFormat } from "@/lib/application-fee-waiver";
import { stripSubmissionDataUrls } from "@/lib/manager-listing-draft-autosave";
import { uploadListingSubmissionMedia } from "@/lib/listing-submission-media-upload";
import {
  applyListingBathroomSlots,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

export type PrepareListingSubmissionResult = {
  submission: ManagerListingSubmissionV1;
  droppedMediaCount: number;
};

/**
 * The single pre-save pass both listing wizards must run before touching
 * `POST /api/property-records`: normalize, upload any lingering base64 media,
 * and refuse promo codes the server would reject anyway.
 */
export async function prepareListingSubmissionForPersist(
  sub: ManagerListingSubmissionV1,
  opts?: { accountPaymentWaiverGranted?: boolean; validateWaiverCode?: boolean },
): Promise<PrepareListingSubmissionResult> {
  const normalized = normalizeManagerListingSubmissionV1(sub, {
    accountPaymentWaiverGranted: opts?.accountPaymentWaiverGranted,
  });
  const withBaths = applyListingBathroomSlots(normalized);
  const ready = withBaths.ok ? withBaths.sub : normalized;

  const waiverCode = ready.applicationFeeWaiverCode?.trim() ?? "";
  // A draft is deliberately partial. The records route applies this same
  // distinction, so a manager can keep an incomplete promo code and finish it
  // later without losing the rest of the listing.
  if (opts?.validateWaiverCode !== false && waiverCode && !isValidWaiverCodeFormat(waiverCode)) {
    throw new Error("Application fee waive code must be 4–32 letters, numbers, or hyphens.");
  }

  try {
    const uploaded = await uploadListingSubmissionMedia(ready);
    return { submission: uploaded.submission, droppedMediaCount: uploaded.failedCount };
  } catch (err) {
    console.error("prepare-listing-submission-for-persist: media upload failed", err);
    return { submission: stripSubmissionDataUrls(ready), droppedMediaCount: 0 };
  }
}

/** Turn a server refusal or client validation error into wizard toast copy. */
export function listingSaveFailureMessage(serverReason: string): string {
  const trimmed = serverReason.trim();
  if (!trimmed) {
    return "Could not save your changes. Check your connection and try again.";
  }
  if (trimmed.startsWith("Application-fee promo code:")) {
    return `Could not save — ${trimmed.replace(/^Application-fee promo code:\s*/i, "").replace(/\.$/, "")}.`;
  }
  return `Could not save your changes — ${trimmed.replace(/\.$/, "")}.`;
}
