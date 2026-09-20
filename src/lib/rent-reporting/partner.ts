/**
 * Rent reporting furnisher partner interface.
 *
 * PropLane is a RESELLER of a furnisher partner (Esusu / Boom style) — it never reports
 * to Experian/TransUnion/Equifax itself. Behind this one interface a later drop-in
 * replaces {@link StubRentReportingPartner} with the signed partner's real client; no
 * other code in the app should import a partner SDK directly.
 *
 * The stub records what WOULD be sent (no network) so the rest of the pipeline —
 * consent, export, the resident card, the cron job — can be built and tested end to
 * end ahead of the partner contract landing.
 */

export const RENT_REPORTING_BUREAUS = ["Experian", "TransUnion", "Equifax"] as const;

export const RENT_REPORTING_BUREAUS_LABEL = RENT_REPORTING_BUREAUS.join(" · ");

export type RentReportingSubject = {
  /** This account's `resident_rent_reporting.id`, never exposed to the partner as-is if their API wants its own id shape. */
  reportingId: string;
  legalName: string;
  dob: string;
  /** Free-form household/lease identity the partner can key its own subject id off of. */
  propertyLabel?: string;
};

export type RentReportingSubmissionRow = {
  reportingId: string;
  partnerSubjectId: string;
  period: string;
  amountCents: number;
  dueDate: string;
  paidDate: string | null;
  status: "on_time" | "late_30" | "late_60" | "late_90" | "unpaid";
};

export type RentReportingPartnerReceipt = {
  partner: string;
  receivedAt: string;
  [key: string]: unknown;
};

export interface RentReportingPartner {
  /**
   * True only for a signed furnisher that actually reports to the bureaus.
   * While this is false the product shows rent reporting as "Coming soon":
   * the resident card and consent sheet do not render, the manager add-on
   * cannot be turned on, and the assistant answers that it is not available
   * yet — so nobody consents to, or is told about, reporting that does not
   * happen. Nothing else changes when a live partner is wired in.
   */
  readonly live: boolean;
  /** Enroll a resident with the partner; returns the partner's own subject id. */
  enroll(subject: RentReportingSubject): Promise<{ partnerSubjectId: string }>;
  /** Submit one period's rows for one or more subjects. Returns a receipt per row, keyed by reportingId+period. */
  submit(rows: RentReportingSubmissionRow[]): Promise<Map<string, RentReportingPartnerReceipt>>;
  /** Stop reporting for a subject going forward. */
  stop(partnerSubjectId: string): Promise<void>;
}

function submissionKey(reportingId: string, period: string): string {
  return `${reportingId}::${period}`;
}

/**
 * Records what would be sent, in memory-shaped receipts the caller persists to
 * `rent_reporting_submissions.partner_receipt`. No network call. The real partner's
 * client will implement the same interface and be swapped in at the one call site
 * (`export.server.ts` / the monthly cron route) with no other code changing.
 */
export class StubRentReportingPartner implements RentReportingPartner {
  readonly live = false;

  async enroll(subject: RentReportingSubject): Promise<{ partnerSubjectId: string }> {
    return { partnerSubjectId: `stub_${subject.reportingId}` };
  }

  async submit(rows: RentReportingSubmissionRow[]): Promise<Map<string, RentReportingPartnerReceipt>> {
    const receipts = new Map<string, RentReportingPartnerReceipt>();
    const receivedAt = new Date().toISOString();
    for (const row of rows) {
      receipts.set(submissionKey(row.reportingId, row.period), {
        partner: "stub",
        receivedAt,
        partnerSubjectId: row.partnerSubjectId,
        period: row.period,
        amountCents: row.amountCents,
        status: row.status,
        note: "Recorded only — no live furnisher partner is signed yet.",
      });
    }
    return receipts;
  }

  async stop(): Promise<void> {
    // Nothing to notify — no network call in the stub.
  }
}

let sharedPartner: RentReportingPartner | null = null;

/** The one call site every caller resolves the active partner through. */
export function getRentReportingPartner(): RentReportingPartner {
  if (!sharedPartner) sharedPartner = new StubRentReportingPartner();
  return sharedPartner;
}

/** Whether a live furnisher is wired — the one gate every rent-reporting surface reads. */
export function isRentReportingPartnerLive(): boolean {
  return getRentReportingPartner().live === true;
}

/** Copy every surface uses while no live partner is signed. */
export const RENT_REPORTING_COMING_SOON = "Rent reporting is coming soon.";
