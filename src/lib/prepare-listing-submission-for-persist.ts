import { isValidWaiverCodeFormat } from "@/lib/application-fee-waiver";
import { stripSubmissionDataUrls } from "@/lib/manager-listing-draft-autosave";
import { uploadListingSubmissionMedia } from "@/lib/listing-submission-media-upload";
import {
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
  opts?: { accountPaymentWaiverGranted?: boolean },
): Promise<PrepareListingSubmissionResult> {
  const normalized = normalizeManagerListingSubmissionV1(sub, {
    accountPaymentWaiverGranted: opts?.accountPaymentWaiverGranted,
  });

  const waiverCode = normalized.applicationFeeWaiverCode?.trim() ?? "";
  if (waiverCode && !isValidWaiverCodeFormat(waiverCode)) {
    throw new Error("Application fee waive code must be 4–32 letters, numbers, or hyphens.");
  }

  try {
    const uploaded = await uploadListingSubmissionMedia(normalized);
    return { submission: uploaded.submission, droppedMediaCount: uploaded.failedCount };
  } catch (err) {
    console.error("prepare-listing-submission-for-persist: media upload failed", err);
    return { submission: stripSubmissionDataUrls(normalized), droppedMediaCount: 0 };
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
