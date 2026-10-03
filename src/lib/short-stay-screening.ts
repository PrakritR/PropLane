import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const SCREENING_CONSENT_KEY = "consent:Credit & background check consent";

/** True when the listing's short-term application still asks for credit/background consent. */
export function shortStayScreeningRequired(sub: ManagerListingSubmissionV1 | null | undefined): boolean {
  if (!sub?.shortTermRentalsAllowed) return false;
  const disabledSource =
    sub.shortTermApplicationConfigMode === "custom"
      ? sub.shortTermDisabledStandardApplicationKeys
      : sub.shortTermDisabledStandardApplicationKeys ?? sub.disabledStandardApplicationKeys;
  const disabled = new Set((disabledSource ?? []).map((key) => key.trim()));
  return !disabled.has(SCREENING_CONSENT_KEY);
}
