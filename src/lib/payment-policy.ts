import { parseMoneyAmount } from "@/lib/parse-money";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { platformFeeCents } from "@/lib/platform-fees";
import { isWaiverGrantedManagerPurchase, type ManagerSkuTier } from "@/lib/manager-access";

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
 * resident charge. Resolved for one payment by {@link resolveServiceFeePayerFor}
 * (staff override → property setting → account default, under the plan rule in
 * {@link resolveServiceFeePayer}); it is the single value that decides how the
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
 * Every place a fee-payer choice can be recorded, in the order they override each other.
 *
 * `adminOverride` is PropLane staff acting on one manager's account; `propertyChoice` is that
 * manager's per-property setting in Pricing; `managerChoice` is their account-wide default.
 */
export type ServiceFeePayerInputs = {
  tier: ManagerSkuTier;
  /** Set by PropLane staff in the admin portal. Absent means staff have not intervened. */
  adminOverride?: ServiceFeePayer | null;
  /** This property's Pricing setting. Absent means it follows the account default. */
  propertyChoice?: ServiceFeePayer | null;
  /** The manager's account-wide default. */
  managerChoice?: ServiceFeePayer | null;
  /**
   * Server-validated payment-waiver grant (e.g. FREE100). Lets a Free-tier manager
   * select PropLane-absorbed fees where the product allows it.
   */
  waiverGranted?: boolean;
};

/** Whether PropLane absorb is selectable in Pricing / payment setup for this account. */
export function managerCanSelectProplaneServiceFee(
  tier: ManagerSkuTier,
  waiverGranted: boolean,
): boolean {
  return tier !== "free" || waiverGranted;
}

/** Whether the manager-absorb option is selectable (paid capability). */
export function managerCanSelectManagerAbsorbServiceFee(tier: ManagerSkuTier): boolean {
  return tier !== "free";
}

/** UI value when a listing has no explicit per-property choice yet. */
export function listingServiceFeePayerUiValue(
  stored: ServiceFeePayer | null | undefined,
  _tier: ManagerSkuTier,
  _waiverGranted = false,
): ServiceFeePayer {
  if (stored === "resident" || stored === "manager" || stored === "proplane") return stored;
  return "resident";
}

/**
 * Per-listing storage: `proplane` is kept only with a valid FREE100 waiver code;
 * otherwise fall back to resident pays (never persist absorb without the code).
 */
export function persistListingServiceFeePayer(
  payer: ServiceFeePayer | null | undefined,
  waiverCode: string | null | undefined,
  accountWaiverGranted = false,
): { serviceFeePayer: ServiceFeePayer | null; serviceFeeWaiverCode?: string } {
  if (payer === "resident" || payer === "manager") {
    return { serviceFeePayer: payer, serviceFeeWaiverCode: undefined };
  }
  if (
    payer === "proplane" &&
    (listingPaymentWaiverCodeMatches(waiverCode) || accountWaiverGranted)
  ) {
    return {
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: listingPaymentWaiverCodeMatches(waiverCode)
        ? normalizeListingPaymentWaiverCode(waiverCode ?? "")
        : LISTING_PAYMENT_WAIVER_CODE,
    };
  }
  if (payer === "proplane") {
    return { serviceFeePayer: "resident", serviceFeeWaiverCode: undefined };
  }
  return { serviceFeePayer: null, serviceFeeWaiverCode: undefined };
}

export function waiverGrantedFromPromoCode(promoCode: string | null | undefined): boolean {
  return isWaiverGrantedManagerPurchase(promoCode);
}

export function resolveAccountOrListingWaiverGranted(
  accountPromoCode: string | null | undefined,
  listingWaiverCode?: string | null,
): boolean {
  return waiverGrantedFromPromoCode(accountPromoCode) || listingPaymentWaiverCodeMatches(listingWaiverCode);
}

/** Per-listing waiver code accepted on the Pricing step (Free + PropLane absorb). */
export const LISTING_PAYMENT_WAIVER_CODE = "FREE100";

export function normalizeListingPaymentWaiverCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function listingPaymentWaiverCodeMatches(code: string | null | undefined): boolean {
  const normalized = normalizeListingPaymentWaiverCode(code ?? "");
  return normalized.length > 0 && normalized === LISTING_PAYMENT_WAIVER_CODE;
}

/** PropLane absorb in the listing wizard requires a per-listing waiver code unless the account already has one. */
export function listingProplaneAbsorbNeedsWaiverCode(
  _tier: ManagerSkuTier,
  serviceFeePayer: ServiceFeePayer | null | undefined,
  accountWaiverGranted: boolean,
): boolean {
  if (accountWaiverGranted) return false;
  return serviceFeePayer === "proplane";
}

/** User-facing copy — never embed the literal comp code in the product UI. */
export const LISTING_PROCESSING_FEE_WAIVER_CODE_HELP =
  "PropLane will share a waiver code with you directly. Contact support if you do not have one.";

export const LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID =
  "Enter the waiver code PropLane gave you.";

/**
 * Who pays the processing fee on one payment.
 *
 * Precedence, most specific first:
 *
 *   1. **The admin override**, which alone can select `proplane` — PropLane absorbing Stripe's
 *      cost so that NEITHER the resident nor the manager is charged. That is PropLane spending
 *      its own money, so it is deliberately not something a manager can switch on for themselves.
 *      It also ignores the plan floor below: staff choosing to absorb a free-tier manager's fees
 *      is the whole point of the control.
 *   2. **The property's own Pricing setting**, so a manager running one building where they
 *      absorb fees and another where residents pay is expressible.
 *   3. **The manager's account default**, which is what a new property inherits.
 *   4. **The plan default** — `proplane` on a paid plan, `resident` on Free.
 *
 * Step 4 is the AXI-149 rule: "PropLane takes all processing fees for paid accounts." A manager
 * who is paying for the product does not additionally hand Stripe's cost to their residents by
 * default; PropLane's own balance bears it. It is a DEFAULT, not a floor — a paid manager who has
 * explicitly chosen `resident` or `manager`, on the account or on one property, keeps that choice,
 * because a manager who deliberately passes the fee on should not silently stop.
 *
 * Steps 2-4 stay subject to the plan floor: a free-tier manager cannot shift the fee off their
 * residents, because absorbing fees is a paid capability. Only staff can override that.
 *
 * `proplane` from a MANAGER or PROPERTY field is honoured on any PAID plan, since absorbing the
 * fee is now what a paid plan does. On Free it is still discarded and the plan rule applies:
 * there, it would let a manager stop paying by writing a value the settings UI never offers them
 * into their own record, with PropLane picking up the bill. Staff can still direct it at PropLane
 * on any plan.
 */
export function resolveServiceFeePayerFor(input: ServiceFeePayerInputs): ServiceFeePayer {
  if (input.adminOverride) return normalizeServiceFeeChoice(input.adminOverride);

  const waiverGranted = input.waiverGranted === true;
  const effectiveTier: ManagerSkuTier = input.tier === "free" && waiverGranted ? "pro" : input.tier;
  // `??` rather than a normalize call, so "nothing is set" stays distinguishable
  // from "explicitly resident" — normalizeServiceFeeChoice collapses both to
  // "resident", which would make the paid-plan default unreachable.
  const stored = input.propertyChoice ?? input.managerChoice ?? null;
  const planDefault: ServiceFeePayer = effectiveTier === "free" ? "resident" : "proplane";
  const normalized = stored == null ? planDefault : normalizeServiceFeeChoice(stored);
  // Absorbing the fee is a paid capability; a value that appears on Free anyway is
  // discarded rather than honoured — unless the account has a server-validated waiver.
  const manageable: ServiceFeePayer =
    normalized === "proplane" && input.tier === "free" && !waiverGranted ? "resident" : normalized;
  return resolveServiceFeePayer(effectiveTier, manageable);
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
  if (axisPaymentsEnabledOnListing(sub)) {
    return ["PropLane payments — bank (ACH), card (Apple Pay), or Link"];
  }
  return ["PropLane online payments — ask your manager to finish payment setup."];
}

/** Stripe checkout methods only — Zelle/Venmo are retired from the product. */
export type ResidentAcceptedPaymentMethod = "ach" | "card";

export const RESIDENT_ACCEPTED_PAYMENT_METHODS: ResidentAcceptedPaymentMethod[] = ["ach", "card"];

export const RESIDENT_ACCEPTED_PAYMENT_METHOD_LABELS: Record<ResidentAcceptedPaymentMethod, string> = {
  ach: "Bank (ACH)",
  card: RESIDENT_CARD_PAYMENT_DISPLAY_LABEL,
};

export function isResidentAcceptedPaymentMethod(value: unknown): value is ResidentAcceptedPaymentMethod {
  return typeof value === "string" && (RESIDENT_ACCEPTED_PAYMENT_METHODS as string[]).includes(value);
}

/** Payment methods a property accepts from residents — Stripe (ACH + card) only. */
export function acceptedPaymentMethodsForListing(
  sub: Pick<ManagerListingSubmissionV1, "acceptedPaymentMethods"> | null | undefined,
): ResidentAcceptedPaymentMethod[] {
  const raw = sub?.acceptedPaymentMethods;
  const stripeOnly = (RESIDENT_ACCEPTED_PAYMENT_METHODS as readonly string[]);
  if (!Array.isArray(raw) || raw.length === 0) return [...RESIDENT_ACCEPTED_PAYMENT_METHODS];
  const filtered = raw.filter(
    (m): m is ResidentAcceptedPaymentMethod =>
      typeof m === "string" && stripeOnly.includes(m),
  );
  return filtered.length > 0 ? filtered : [...RESIDENT_ACCEPTED_PAYMENT_METHODS];
}
