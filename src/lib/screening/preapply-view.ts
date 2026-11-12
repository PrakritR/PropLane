import type { ApplicantScreeningQuote } from "@/lib/screening/applicant-screening";
import type { PreApplyIdProvider, PreApplyState, PreApplyStep } from "@/lib/screening/preapply";

/** The pre-apply status route's JSON, shared with the applicant gate so the two cannot drift. */
export type PreApplyApiView = {
  required: boolean;
  satisfied: boolean;
  steps: PreApplyStep[];
  next: PreApplyState["next"];
  provider: PreApplyIdProvider | null;
  /** The exact total for the order the applicant would pay now; null when no order is open to them. */
  quote: ApplicantScreeningQuote | null;
  orderAllowed: boolean;
  disclosure: { version: string; text: string; authorizationLabel: string };
};
