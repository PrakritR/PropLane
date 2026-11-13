/**
 * FCRA adverse action: the pure rules and the notice wording, shared by the routes, the manager's decline flow and
 * the tests. No I/O.
 *
 * When a manager declines (or conditions) an application for which a Checkr consumer report exists, they must answer
 * "Is this decision based in whole or part on the background check?". If YES:
 *   1. PRE-ADVERSE notice: the applicant gets a copy of the report, the CFPB "Summary of Your Rights Under the FCRA",
 *      the consumer reporting agency's name/address/phone and the right to dispute, before anything is final.
 *   2. A waiting period of five business days (`finalDueAt`). The decision is not final inside it.
 *   3. FINAL adverse-action notice (same elements, plus that the agency did not make the decision), then the usual
 *      decline. The manager sends it with Finalize once the window has passed.
 * If NO, the application is declined with the normal decline notice and nothing else.
 *
 * COUNSEL REVIEW REQUIRED before live rollout: every sentence in `preAdverseNotice` / `finalAdverseNotice`, the waiting
 * period, the holiday list and the agency contact details. See docs/agents/identity-and-screening.md § Adverse action.
 */

export const ADVERSE_ACTION_NOTICE_VERSION = "2026-11-12";

/** Business days between the pre-adverse notice and the earliest final notice. */
export const ADVERSE_ACTION_WAIT_BUSINESS_DAYS = 5;

/** CFPB "A Summary of Your Rights Under the Fair Credit Reporting Act" (the prescribed summary). Verify before launch. */
export const CFPB_FCRA_RIGHTS_SUMMARY_URL =
  "https://files.consumerfinance.gov/f/documents/bcfp_consumer-rights-summary_2018-09.pdf";

/** The consumer reporting agency named in both notices. Overridable per deployment; verify before launch. */
export function checkrAgencyContact(env: Record<string, string | undefined> = process.env): {
  name: string;
  address: string;
  phone: string;
} {
  return {
    name: env.CHECKR_CRA_NAME?.trim() || "Checkr, Inc.",
    address: env.CHECKR_CRA_ADDRESS?.trim() || "One Montgomery Street, Suite 2000, San Francisco, CA 94104",
    phone: env.CHECKR_CRA_PHONE?.trim() || "(844) 824-3247",
  };
}

export type AdverseActionStage = "not_based" | "pre_adverse_sent" | "finalized" | "canceled";
export type AdverseActionKind = "decline" | "condition";

export type AdverseActionFacts = {
  id: string;
  reportId: string;
  basedOnReport: boolean;
  stage: AdverseActionStage;
  kind: AdverseActionKind;
  preAdverseSentAt: string | null;
  finalDueAt: string | null;
  finalSentAt: string | null;
};

/** What the decline screen and the routes read: where this application stands on its consumer report. */
export type AdverseActionStatus = {
  /** A completed consumer report exists for this application, so the manager must answer the question before declining. */
  required: boolean;
  stage: AdverseActionStage | "none";
  basedOnReport: boolean | null;
  preAdverseSentAt: string | null;
  finalDueAt: string | null;
  finalSentAt: string | null;
  /** The decline may be saved right now. */
  declineAllowed: boolean;
  /** The final notice may be sent right now (the waiting period has passed). */
  canFinalize: boolean;
};

// ---------------------------------------------------------------- business days

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}

/** US federal holidays (as OBSERVED on a weekday) for a year, as `YYYY-MM-DD`. */
export function usFederalHolidays(year: number): Set<string> {
  const fixed: Array<[number, number]> = [
    [0, 1], // New Year's Day
    [5, 19], // Juneteenth
    [6, 4], // Independence Day
    [10, 11], // Veterans Day
    [11, 25], // Christmas Day
  ];
  const days: Array<[number, number]> = [
    ...fixed,
    [0, nthWeekdayOfMonth(year, 0, 1, 3)], // Martin Luther King Jr. Day
    [1, nthWeekdayOfMonth(year, 1, 1, 3)], // Washington's Birthday
    [4, lastWeekdayOfMonth(year, 4, 1)], // Memorial Day
    [8, nthWeekdayOfMonth(year, 8, 1, 1)], // Labor Day
    [9, nthWeekdayOfMonth(year, 9, 1, 2)], // Columbus Day
    [10, nthWeekdayOfMonth(year, 10, 4, 4)], // Thanksgiving
  ];
  const out = new Set<string>();
  for (const [month, day] of days) {
    const date = new Date(Date.UTC(year, month, day));
    const weekday = date.getUTCDay();
    // A Saturday holiday is observed Friday, a Sunday holiday Monday.
    if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
    else if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
    out.add(date.toISOString().slice(0, 10));
  }
  return out;
}

function isBusinessDay(date: Date): boolean {
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const key = date.toISOString().slice(0, 10);
  return !usFederalHolidays(date.getUTCFullYear()).has(key) && !usFederalHolidays(date.getUTCFullYear() + 1).has(key);
}

/**
 * `days` business days after `from` (weekends and US federal holidays never count; the day of sending is day zero).
 * The time of day is kept, so the window is the same length however late the notice went out.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const out = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    if (isBusinessDay(out)) remaining -= 1;
  }
  return out;
}

export function adverseActionFinalDueAt(preAdverseSentAt: Date): Date {
  return addBusinessDays(preAdverseSentAt, ADVERSE_ACTION_WAIT_BUSINESS_DAYS);
}

// ---------------------------------------------------------------- the decline decision

/**
 * May the application be moved to Declined, given the latest adverse-action record for THIS report? Yes only when the
 * manager answered "not based on the report" or the final notice has gone out. No record for the report (including a
 * record made against an earlier report), a pre-adverse notice still waiting, or a canceled action all refuse.
 */
export function adverseActionAllowsDecline(
  facts: Pick<AdverseActionFacts, "reportId" | "stage"> | null,
  currentReportId: string,
): boolean {
  if (!facts || facts.reportId !== currentReportId) return false;
  return facts.stage === "not_based" || facts.stage === "finalized";
}

export type FinalizeAvailability =
  | { ok: true }
  | { ok: false; reason: "not_pre_adverse" }
  | { ok: false; reason: "waiting"; dueAt: string };

export function adverseActionFinalizeAvailability(
  facts: Pick<AdverseActionFacts, "stage" | "finalDueAt"> | null,
  now: Date,
): FinalizeAvailability {
  if (!facts || facts.stage !== "pre_adverse_sent" || !facts.finalDueAt) return { ok: false, reason: "not_pre_adverse" };
  if (now.getTime() < Date.parse(facts.finalDueAt)) return { ok: false, reason: "waiting", dueAt: facts.finalDueAt };
  return { ok: true };
}

// ---------------------------------------------------------------- notices

export type AdverseNoticeInput = {
  applicantName: string;
  propertyLabel?: string;
  kind: AdverseActionKind;
  /** Authenticated link to the applicant's copy of the report (sign-in required, never a Checkr URL). */
  reportUrl: string;
  /** Pre-adverse only: the day the final decision may be made. */
  finalDate?: string;
  agency?: { name: string; address: string; phone: string };
};

export type AdverseNotice = { subject: string; text: string; smsText: string };

function decisionPhrase(kind: AdverseActionKind): { gerund: string; past: string } {
  return kind === "condition"
    ? { gerund: "approving your application only on added conditions", past: "approved your application only on added conditions" }
    : { gerund: "declining your application", past: "declined your application" };
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
}

function agencyBlock(agency: { name: string; address: string; phone: string }): string {
  return `${agency.name}\n${agency.address}\n${agency.phone}`;
}

/** Step 1: before any final decision. Plain, specific, and never says the decision is already made. */
export function preAdverseNotice(input: AdverseNoticeInput): AdverseNotice {
  const agency = input.agency ?? checkrAgencyContact();
  const phrase = decisionPhrase(input.kind);
  const at = input.propertyLabel?.trim() ? ` for ${input.propertyLabel.trim()}` : "";
  const finalDate = formatDate(input.finalDate);
  const text = [
    `Hello ${input.applicantName.trim() || "there"},`,
    "",
    `We are considering ${phrase.gerund}${at}. Information in a consumer report about you is part of the reason we are considering this. This is not a final decision.`,
    "",
    `The report was prepared by:\n${agencyBlock(agency)}`,
    "",
    `${agency.name} only supplied the report. It did not make this decision and cannot tell you why we are considering it.`,
    "",
    `Your copy of the report: ${input.reportUrl} (sign in to your PropLane account to open it).`,
    `A Summary of Your Rights Under the Fair Credit Reporting Act: ${CFPB_FCRA_RIGHTS_SUMMARY_URL}`,
    "",
    "If anything in the report is wrong or incomplete, you have the right to dispute it directly with the agency above, and to ask them for another free copy within 60 days of this notice.",
    finalDate
      ? `If you want us to consider a correction or other information, tell your property manager in PropLane before ${finalDate}. We will not make a final decision before then.`
      : "If you want us to consider a correction or other information, tell your property manager in PropLane. We will not make a final decision for at least five business days.",
  ].join("\n");
  return {
    subject: "Notice before a decision on your application",
    text,
    smsText: `We are considering ${phrase.gerund}${at} based in part on a consumer report. This is not final. Read your copy and your rights: ${input.reportUrl}`,
  };
}

/** Step 3: after the waiting period. Names the agency, says it did not decide, repeats the right to dispute. */
export function finalAdverseNotice(input: AdverseNoticeInput): AdverseNotice {
  const agency = input.agency ?? checkrAgencyContact();
  const phrase = decisionPhrase(input.kind);
  const at = input.propertyLabel?.trim() ? ` for ${input.propertyLabel.trim()}` : "";
  const text = [
    `Hello ${input.applicantName.trim() || "there"},`,
    "",
    `We have ${phrase.past}${at}. Information in a consumer report about you was part of the reason for this decision.`,
    "",
    `The report was prepared by:\n${agencyBlock(agency)}`,
    "",
    `${agency.name} did not make this decision and is unable to provide the specific reasons for it.`,
    "",
    "You have the right to a free copy of the report from the agency above if you ask within 60 days of this notice, and the right to dispute directly with the agency the accuracy or completeness of any information in it.",
    `Your copy of the report: ${input.reportUrl} (sign in to your PropLane account to open it).`,
    `A Summary of Your Rights Under the Fair Credit Reporting Act: ${CFPB_FCRA_RIGHTS_SUMMARY_URL}`,
  ].join("\n");
  return {
    subject: "Decision on your application",
    text,
    smsText: `We have ${phrase.past}${at} based in part on a consumer report. Your rights and your copy of the report: ${input.reportUrl}`,
  };
}

/** Sent when the manager withdraws a pre-adverse notice during the waiting period. */
export function adverseActionCanceledNotice(input: { applicantName: string; propertyLabel?: string }): AdverseNotice {
  const at = input.propertyLabel?.trim() ? ` for ${input.propertyLabel.trim()}` : "";
  const text = `Hello ${input.applicantName.trim() || "there"},\n\nThe earlier notice about your application${at} is withdrawn. No adverse decision has been made on the basis of the consumer report.`;
  return { subject: "Update on your application", text, smsText: text.replace(/\n+/g, " ") };
}
