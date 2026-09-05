import {
  longTermUtilitiesEstimateRequired,
  type UtilitiesPaymentModel,
} from "@/lib/listing-utilities-payment";
import { parseMoneyAmount } from "@/lib/parse-money";

/**
 * The rental context a set of fees is being configured for. A room priced on its own,
 * a group of rooms leased together, and a whole-house lease each want DIFFERENT default
 * fees — this is the key the default template is looked up by.
 */
export type ListingFeeContext = "per_room" | "group_bundle" | "whole_house";

export interface ListingFeeContextDefaults {
  /** Security deposit as a multiple of the context's monthly rent (0 = no default deposit). */
  securityDepositMonths: number;
  /** Utilities model applied by default. */
  utilitiesPaymentModel: Extract<UtilitiesPaymentModel, "manager_billed" | "tenant_direct">;
  /** Default monthly utilities estimate (money string) when manager_billed; "" otherwise. */
  utilitiesEstimate: string;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TUNING SURFACE. This map is the ONE place to retune PropLane's out-of-the-box
 * fee defaults per rental context. Everything else (bundle creation, new-listing
 * seeding) reads from here, so changing a default is a one-line edit — no scattered
 * conditionals. Deposits are expressed as months-of-rent so they scale with price.
 *
 * The three contexts deliberately differ:
 *  - per_room:     manager bills a modest per-room utilities estimate; deposit = 1 mo.
 *  - group_bundle: ONE bundle-level deposit (not per room) and a larger, whole-group
 *                  utilities estimate that the manager bills as a single line.
 *  - whole_house:  a whole-property lease where the tenant typically holds the utility
 *                  accounts, so utilities default to resident-paid; deposit = 1 mo.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const LISTING_FEE_CONTEXT_DEFAULTS: Record<ListingFeeContext, ListingFeeContextDefaults> = {
  per_room: {
    securityDepositMonths: 1,
    utilitiesPaymentModel: "manager_billed",
    utilitiesEstimate: "75",
  },
  group_bundle: {
    securityDepositMonths: 1,
    utilitiesPaymentModel: "manager_billed",
    utilitiesEstimate: "250",
  },
  whole_house: {
    securityDepositMonths: 1,
    utilitiesPaymentModel: "tenant_direct",
    utilitiesEstimate: "",
  },
};

/** The bundle-generation kinds map onto their fee context. */
export function feeContextForBundleKind(kind: "whole_house" | "multi_room" | "custom"): ListingFeeContext {
  return kind === "whole_house" ? "whole_house" : "group_bundle";
}

export interface ResolvedListingFeeDefaults {
  securityDeposit: string;
  utilitiesPaymentModel: Extract<UtilitiesPaymentModel, "manager_billed" | "tenant_direct">;
  utilitiesEstimate: string;
}

/** Concrete default values for a context, deposit computed from the context's monthly rent. */
export function resolveListingFeeContextDefaults(
  context: ListingFeeContext,
  monthlyRent: number,
): ResolvedListingFeeDefaults {
  const d = LISTING_FEE_CONTEXT_DEFAULTS[context];
  const deposit =
    monthlyRent > 0 && d.securityDepositMonths > 0
      ? String(Math.round(monthlyRent * d.securityDepositMonths))
      : "";
  return {
    securityDeposit: deposit,
    utilitiesPaymentModel: d.utilitiesPaymentModel,
    utilitiesEstimate: d.utilitiesEstimate,
  };
}

function isEmptyMoney(v: string | undefined): boolean {
  return !v || !v.trim() || parseMoneyAmount(v) <= 0;
}

/**
 * Apply a context's defaults to a fee-bearing target (a bundle) WITHOUT destroying
 * values the manager already typed: an already-filled security deposit or utilities
 * estimate is left untouched; only empty fields receive the default. The utilities
 * model is only defaulted when the target has none yet.
 */
export function applyListingFeeContextDefaults<
  T extends { securityDeposit?: string; utilitiesPaymentModel?: UtilitiesPaymentModel; utilitiesEstimate?: string },
>(target: T, context: ListingFeeContext, monthlyRent: number): T {
  const d = resolveListingFeeContextDefaults(context, monthlyRent);
  const next: T = { ...target };
  if (isEmptyMoney(next.securityDeposit) && d.securityDeposit) {
    next.securityDeposit = d.securityDeposit;
  }
  if (!next.utilitiesPaymentModel) {
    next.utilitiesPaymentModel = d.utilitiesPaymentModel;
  }
  if (
    longTermUtilitiesEstimateRequired(next.utilitiesPaymentModel) &&
    isEmptyMoney(next.utilitiesEstimate) &&
    d.utilitiesEstimate
  ) {
    next.utilitiesEstimate = d.utilitiesEstimate;
  }
  return next;
}
