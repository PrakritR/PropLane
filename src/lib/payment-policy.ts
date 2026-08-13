import { parseMoneyAmount } from "@/lib/parse-money";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { platformFeeCents } from "@/lib/platform-fees";
import type { ManagerSkuTier } from "@/lib/manager-access";

export type RentDueDayMode = "first_of_month" | "last_of_month";

/** @deprecated Prefer PaymentReminderKind from payment-automation-settings. */
export type PaymentReminderSlot = "7d" | "5d" | "3d" | "12h" | "overdue_daily";

/** Recommended charge presets managers can pick when adding a custom payment line. */
export const MANAGER_PAYMENT_PRESETS = [
  { id: "application_fee", label: "Application fee" },
  { id: "rent", label: "Rent" },
  { id: "utilities", label: "Utilities" },
  { id: "move_in_fee", label: "Move-in fee" },
  { id: "prorated_rent", label: "Prorated rent" },
  { id: "security_deposit", label: "Security deposit" },
  { id: "late_fee", label: "Late payment fee" },
  { id: "other", label: "Custom charge" },
] as const;

export type ManagerPaymentPresetId = (typeof MANAGER_PAYMENT_PRESETS)[number]["id"];

/** @deprecated Legacy display constant — prefer residentProcessingFeeCents. Stripe's ACH rate is 0.8%. */
export const AXIS_ACH_FEE_PERCENT = 0.8;

export type ResidentAxisPaymentMethod = "ach" | "card" | "link";

/** User-facing label for the card method-class (includes Apple Pay / Google Pay wallets in Checkout). */
export const RESIDENT_CARD_PAYMENT_DISPLAY_LABEL = "Card · Apple Pay";

/**
 * Who bears the payment "service fee" (Stripe's real processing cost) on a
 * resident charge. Resolved per manager from the plan tier + the Pro choice by
 * {@link resolveServiceFeePayer}; it is the single value that decides how the
 * fee is placed on the Connect destination charge:
 * - `resident`  — added on top of what the resident pays (retained as the
 *   Connect `application_fee_amount`, so the manager still gets the subtotal).
 * - `manager`   — NOT added to the resident total; retained as the
 *   `application_fee_amount`, so it comes out of the manager's proceeds.
 * - `proplane`  — no fee added and none retained; PropLane's own Stripe balance
 *   bears Stripe's cost (the historical "face value on every method" model).
 */
export type ServiceFeePayer = "resident" | "manager" | "proplane";

/** @deprecated Use {@link ServiceFeePayer} — kept for older call sites. */
export type ProServiceFeeChoice = "resident" | "manager";

/** Normalize the stored per-manager service-fee payer from settings JSON. */
export function normalizeServiceFeeChoice(raw: unknown): ServiceFeePayer {
  if (raw === "manager" || raw === "proplane") return raw;
  return "resident";
}

/** @deprecated Prefer {@link normalizeServiceFeeChoice}. */
export function normalizeProServiceFeeChoice(raw: unknown): ProServiceFeeChoice {
  const choice = normalizeServiceFeeChoice(raw);
  return choice === "manager" ? "manager" : "resident";
}

/**
 * The plan rule, in one place:
 * - Free → the resident always pays (no choice).
 * - Pro / Business → the manager's stored choice (`resident` default).
 *
 * `tier` is already normalized by callers (`normalizeManagerSkuTier(...) ?? "free"`),
 * so a legacy/unknown tier arrives here as `"free"` — resident pays, matching the
 * money layer's existing treatment of an unknown plan.
 */
export function resolveServiceFeePayer(tier: ManagerSkuTier, choice: ServiceFeePayer): ServiceFeePayer {
  if (tier === "free") return "resident";
  return choice;
}

/**
 * Stripe's actual per-method processing cost — the "service fee". This is a
 * pass-through of Stripe's price, never a PropLane markup:
 * - ACH/bank: 0.8% of the subtotal, capped at $5.00 (a cap, hence computed here
 *   rather than a flat bps+fixed).
 * - card/Link: 2.9% + $0.30.
 * The single knob for the fee amount; every disclosure and every charge derives
 * from it so they can never drift.
 */
export function achProcessingFeeCents(subtotalCents: number): number {
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) return 0;
  return Math.min(Math.round((subtotalCents * 80) / 10_000), 500);
}

/** @deprecated Renamed to achProcessingFeeCents. */
export const achPlatformRecoupCents = achProcessingFeeCents;

const RESIDENT_PROCESSING_FEE_BPS: Record<Exclude<ResidentAxisPaymentMethod, "ach">, number> = {
  card: 290,
  link: 290,
};

const RESIDENT_PROCESSING_FEE_FIXED_CENTS: Record<Exclude<ResidentAxisPaymentMethod, "ach">, number> = {
  card: 30,
  link: 30,
};

/**
 * Stripe's per-method processing cost for a subtotal — the raw "service fee"
 * BEFORE deciding who pays it. Placement (added to the resident, taken from the
 * manager, or absorbed by PropLane) is decided by {@link residentServiceFeeBreakdown}.
 */
export function residentProcessingFeeCents(subtotalCents: number, method: ResidentAxisPaymentMethod): number {
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) return 0;
  if (method === "ach") return achProcessingFeeCents(subtotalCents);
  const bps = RESIDENT_PROCESSING_FEE_BPS[method];
  const fixed = RESIDENT_PROCESSING_FEE_FIXED_CENTS[method];
  return Math.floor((subtotalCents * bps) / 10_000) + fixed;
}

/** Platform take rate (0 bps on every tier). Kept separate from the service fee. */
export function residentAxisPlatformFeeCents(subtotalCents: number, managerTier?: string | null): number {
  return platformFeeCents(subtotalCents, "rent", managerTier);
}

/**
 * @deprecated The Connect `application_fee_amount` now depends on WHO pays the
 * fee — use {@link residentServiceFeeBreakdown}. Retained for back-compat as the
 * resident-pays value (service fee + the 0-bps platform take).
 */
export function residentConnectApplicationFeeCents(
  subtotalCents: number,
  method: ResidentAxisPaymentMethod,
  managerTier?: string | null,
): number {
  return residentProcessingFeeCents(subtotalCents, method) + residentAxisPlatformFeeCents(subtotalCents, managerTier);
}

export type ResidentServiceFeeBreakdown = {
  /** Stripe's real processing cost for this method+subtotal (0 when PropLane absorbs). */
  serviceFeeCents: number;
  /** Added on top of the subtotal the resident pays (only when the resident pays). */
  residentAddedFeeCents: number;
  /** Retained by PropLane as the Connect `application_fee_amount` (funds Stripe's cost). */
  applicationFeeCents: number;
  /** What the manager's connected account receives (subtotal, less any fee the manager absorbs). */
  managerPayoutCents: number;
  /** Total the resident is charged (subtotal + residentAddedFeeCents). */
  totalCents: number;
};

/**
 * The single source of truth for how the service fee lands on a Connect
 * destination charge, given who pays it. The checkout builder and every
 * disclosure derive from this, so the resident total, the retained
 * `application_fee_amount`, and the manager payout can never disagree.
 *
 * Invariant, true in all three cases: `totalCents - applicationFeeCents === managerPayoutCents`.
 */
export function residentServiceFeeBreakdown(
  subtotalCents: number,
  method: ResidentAxisPaymentMethod,
  feePayer: ServiceFeePayer,
): ResidentServiceFeeBreakdown {
  const serviceFeeCents = feePayer === "proplane" ? 0 : residentProcessingFeeCents(subtotalCents, method);
  const residentAddedFeeCents = feePayer === "resident" ? serviceFeeCents : 0;
  const applicationFeeCents = feePayer === "proplane" ? 0 : serviceFeeCents;
  const managerPayoutCents = subtotalCents - (feePayer === "manager" ? serviceFeeCents : 0);
  const totalCents = subtotalCents + residentAddedFeeCents;
  return { serviceFeeCents, residentAddedFeeCents, applicationFeeCents, managerPayoutCents, totalCents };
}

/**
 * Fee the MANAGER absorbs out of a resident payment for a given fee-payer.
 * Non-zero only when the manager pays (Pro, "manager" choice); the manager is
 * kept whole otherwise. Kept as a named function so reporting reads intent.
 */
export function managerAbsorbedPaymentFeeCents(
  subtotalCents: number,
  method: ResidentAxisPaymentMethod,
  feePayer: ServiceFeePayer,
): number {
  return feePayer === "manager" ? residentProcessingFeeCents(subtotalCents, method) : 0;
}

/** Per-method fee disclosure — the rate a resident sees when THEY pay the fee. */
export function residentProcessingFeeDisplayLabel(method: ResidentAxisPaymentMethod): string {
  if (method === "ach") return "0.8% bank processing (max $5.00)";
  if (method === "link") return "2.9% + $0.30 Link processing";
  return "2.9% + $0.30 card processing";
}

export function residentPaymentMethodLabel(method: ResidentAxisPaymentMethod): string {
  if (method === "ach") return "Bank (ACH)";
  if (method === "link") return "Link";
  return RESIDENT_CARD_PAYMENT_DISPLAY_LABEL;
}

export function normalizeRentDueDayMode(raw: unknown): RentDueDayMode {
  return raw === "last_of_month" ? "last_of_month" : "first_of_month";
}

export function rentDueDayModeFromSubmission(sub: Pick<ManagerListingSubmissionV1, "rentDueDayMode"> | null | undefined): RentDueDayMode {
  return normalizeRentDueDayMode(sub?.rentDueDayMode);
}

/** Calendar day (1–28/29/30/31) rent is due for a given month key YYYY-MM. */
export function resolveRentDueDayForMonth(mode: RentDueDayMode, monthKey: string): number {
  const [yearRaw, monthRaw] = monthKey.split("-").map(Number);
  const year = yearRaw ?? new Date().getFullYear();
  const monthIndex = (monthRaw ?? 1) - 1;
  if (mode === "last_of_month") {
    return new Date(year, monthIndex + 1, 0).getDate();
  }
  return 1;
}

export function formatRentDueDayLabel(mode: RentDueDayMode): string {
  return mode === "last_of_month" ? "Last day of month" : "1st of month";
}

export function lateFeePolicyFromSubmission(
  sub: Pick<ManagerListingSubmissionV1, "lateFeeEnabled" | "lateFeeGraceDays" | "lateFeeAmount"> | null | undefined,
): { enabled: boolean; graceDays: number; amount: number; amountLabel: string } {
  const enabled = sub?.lateFeeEnabled !== false;
  const graceDays = Math.max(0, Math.min(30, Math.round(Number(sub?.lateFeeGraceDays ?? 5) || 5)));
  const amount = parseMoneyAmount(sub?.lateFeeAmount ?? "50");
  const amountLabel = amount > 0 ? `$${amount.toFixed(2)}` : "$50.00";
  return { enabled, graceDays, amount: amount > 0 ? amount : 50, amountLabel };
}

export function axisPaymentsEnabledOnListing(sub: Pick<ManagerListingSubmissionV1, "axisPaymentsEnabled"> | null | undefined): boolean {
  return sub?.axisPaymentsEnabled !== false;
}

export function axisAchFeeDisplayLabel(): string {
  return "No added fees";
}

export function residentPaymentMethodsSummary(
  sub: Pick<
    ManagerListingSubmissionV1,
    "zellePaymentsEnabled" | "venmoPaymentsEnabled" | "axisPaymentsEnabled" | "zelleContact" | "venmoContact"
  > | null | undefined,
): string[] {
  if (!sub) return ["Contact your property manager for payment instructions."];
  const methods: string[] = [];
  if (sub.zellePaymentsEnabled && sub.zelleContact?.trim()) methods.push(`Zelle (${sub.zelleContact.trim()})`);
  if (sub.venmoPaymentsEnabled && sub.venmoContact?.trim()) methods.push(`Venmo (${sub.venmoContact.trim()})`);
  if (axisPaymentsEnabledOnListing(sub)) {
    methods.push("PropLane payments — bank (ACH), card (Apple Pay), or Link with no added fees");
  }
  if (methods.length === 0) methods.push("Zelle, Venmo, ACH, or cash — your manager marks payments received.");
  return methods;
}

/** The payment method a resident settles a charge with — manager-controlled per property, chosen by the resident. */
export type ResidentAcceptedPaymentMethod = "zelle" | "venmo" | "ach" | "card";

export const RESIDENT_ACCEPTED_PAYMENT_METHODS: ResidentAcceptedPaymentMethod[] = ["zelle", "venmo", "ach", "card"];

export const RESIDENT_ACCEPTED_PAYMENT_METHOD_LABELS: Record<ResidentAcceptedPaymentMethod, string> = {
  zelle: "Zelle",
  venmo: "Venmo",
  ach: "ACH",
  card: RESIDENT_CARD_PAYMENT_DISPLAY_LABEL,
};

export function isResidentAcceptedPaymentMethod(value: unknown): value is ResidentAcceptedPaymentMethod {
  return typeof value === "string" && (RESIDENT_ACCEPTED_PAYMENT_METHODS as string[]).includes(value);
}

/** Payment methods a property accepts from residents. Unset/empty = every method is accepted (default). */
export function acceptedPaymentMethodsForListing(
  sub: Pick<ManagerListingSubmissionV1, "acceptedPaymentMethods"> | null | undefined,
): ResidentAcceptedPaymentMethod[] {
  const raw = sub?.acceptedPaymentMethods;
  if (!Array.isArray(raw) || raw.length === 0) return [...RESIDENT_ACCEPTED_PAYMENT_METHODS];
  const filtered = RESIDENT_ACCEPTED_PAYMENT_METHODS.filter((m) => raw.includes(m));
  return filtered.length > 0 ? filtered : [...RESIDENT_ACCEPTED_PAYMENT_METHODS];
}
