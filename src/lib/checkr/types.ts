import type { CheckrPackage } from "@/lib/checkr/config";
import type { CheckrAddOnSlug } from "@/lib/checkr/packages";

/** Per-product status from GET /orders/{id}/report (Checkr Tenant API). */
export type CheckrProductStatus = "clear" | "consider" | string;

export type CheckrReportProductSnapshot = {
  status?: CheckrProductStatus;
  consider_reasons?: string[];
};

export type CheckrReportSnapshot = {
  criminal_history?: CheckrReportProductSnapshot | null;
  credit_report?: CheckrReportProductSnapshot | null;
  eviction_history?: CheckrReportProductSnapshot | null;
  identity_verification?: CheckrReportProductSnapshot | null;
  income_verification?: CheckrReportProductSnapshot | null;
  sex_offender_registry?: CheckrReportProductSnapshot | null;
  global_watchlist?: CheckrReportProductSnapshot | null;
  credit_score?: number | null;
  est_monthly_income_cents?: number | null;
  est_monthly_payments_cents?: number | null;
};

/** Checkr Tenant API order lifecycle. `complete` carries an aggregate `result`. */
export type CheckrReportStatus = "pending" | "complete" | "canceled";

/** Aggregate adjudication across the order's report products. `null` while pending. */
export type CheckrResult = "clear" | "consider" | null;

/**
 * Persisted background-check state stored on the application record
 * (`DemoApplicantRow.backgroundCheck`). All figures are Checkr-grounded — the
 * model/UI never invents a status.
 */
export type ApplicationBackgroundCheck = {
  provider: "checkr";
  /** Checkr Tenant API applicant id (`ap_test_…` / `ap_…`). */
  candidateId: string;
  /** Checkr Tenant API order id (`ord_test_…` / `ord_…`) — used for polling and webhook lookup. */
  reportId: string;
  /** Checkr report resource id (`rp_test_…` / `rp_…`) — used for official PDF download. */
  reportResourceId?: string;
  packageSlug: CheckrPackage;
  /** Optional add-ons (e.g. identity_verification). */
  addOnProducts?: CheckrAddOnSlug[];
  status: CheckrReportStatus;
  result: CheckrResult;
  orderedAt: string;
  completedAt?: string;
  /** Cached report products for inline preview (no PII). */
  reportSnapshot?: CheckrReportSnapshot;
  /** True when produced by the deterministic simulate fallback (no live call). */
  simulated?: boolean;
  /** Flat fee charged to the manager for this run, and the resulting Stripe PaymentIntent. */
  costCents?: number;
  stripePaymentIntentId?: string;
  /** Stripe Checkout session that prepaid this run (webhook idempotency key). */
  stripeCheckoutSessionId?: string;
  /** Who paid for this run. Absent on older rows = the manager. */
  payer?: "manager" | "applicant";
  /** The applicant's FCRA authorization, captured before the order was paid for and placed. */
  authorization?: { disclosureVersion: string; authorizedAt: string };
  /** Set when this order replaced a cheaper one the applicant had already paid for. */
  upgradedFrom?: { packageSlug: CheckrPackage; reportId: string; costCents?: number };
  /** The ID check's result carried over from the order this one replaced, so an upgrade never re-buys it. */
  carriedIdentity?: { status: string; orderId: string };
};

/** Options when placing a Checkr Tenant order. */
export type CheckrOrderOptions = {
  packageSlug: CheckrPackage;
  addOnProducts?: CheckrAddOnSlug[];
};

/** Result of creating an applicant + property + order with Checkr. */
export type CheckrCreateResult = {
  applicantId: string;
  orderId: string;
  packageSlug: CheckrPackage;
  addOnProducts: CheckrAddOnSlug[];
  status: CheckrReportStatus;
  result: CheckrResult;
  reportSnapshot?: CheckrReportSnapshot;
  reportResourceId?: string;
  simulated: boolean;
};

/** Normalized view of a fetched Checkr order + report. */
export type CheckrReport = {
  orderId: string;
  reportResourceId?: string;
  status: CheckrReportStatus;
  result: CheckrResult;
  reportSnapshot?: CheckrReportSnapshot;
  simulated?: boolean;
};

/** Minimal applicant PII the Checkr applicant needs. Assembled server-side only. */
export type CheckrApplicantInput = {
  firstName: string;
  lastName: string;
  email: string;
  dob: string | null;
  ssn: string;
  phone?: string;
};

/** The rental property being screened for — required by the Tenant API `property` resource. */
export type CheckrPropertyInput = {
  name: string;
  street: string;
  unit?: string;
  city: string;
  state: string;
  zipcode: string;
};
