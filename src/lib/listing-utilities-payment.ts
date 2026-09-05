import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { hasResidentPaidLeaseUtility, normalizeLeaseUtilities } from "@/lib/lease-utilities";
import { parseMoneyAmount } from "@/lib/parse-money";

/**
 * How utilities are paid for a listed room or entire-home lease.
 *
 * `variable` is manager-billed like `manager_billed`, but the amount is not
 * known in advance — it follows actual usage, so the manager raises the real
 * charge each period instead of a fixed recurring one. The listing still
 * carries an estimate, for disclosure only.
 */
export type UtilitiesPaymentModel =
  | "manager_billed"
  | "variable"
  | "tenant_direct"
  | "included_in_rent";

export const UTILITIES_PAYMENT_MODEL_OPTIONS: ReadonlyArray<{
  id: UtilitiesPaymentModel;
  label: string;
  hint: string;
}> = [
  {
    id: "manager_billed",
    label: "Billed through manager",
    hint: "Resident pays the estimated utilities with monthly rent through the portal.",
  },
  {
    id: "variable",
    label: "Billed by usage",
    hint: "Resident pays the manager for actual usage each period; the listing amount is an estimate only.",
  },
  {
    id: "tenant_direct",
    label: "Tenant pays directly",
    hint: "Resident pays utility providers on their own account (estimate optional for disclosure).",
  },
  {
    id: "included_in_rent",
    label: "Included in rent",
    hint: "No separate utilities charge — included in monthly rent.",
  },
] as const;

/** Long-term listing wizard — the three utilities states, in plain manager language. */
export const LONG_TERM_UTILITIES_PAYMENT_OPTIONS: ReadonlyArray<{
  id: UtilitiesPaymentModel;
  label: string;
}> = [
  // "Payment amount" read as an instruction ("enter the payment amount") rather
  // than a state, next to two options that ARE states. It is the fixed monthly
  // utilities charge the manager bills, so name it that.
  { id: "manager_billed", label: "Fixed amount" },
  { id: "variable", label: "Variable (by usage)" },
  { id: "tenant_direct", label: "Paid by resident" },
  { id: "included_in_rent", label: "Included in rent" },
] as const;

export function longTermUtilitiesPickerValue(model: UtilitiesPaymentModel | undefined): UtilitiesPaymentModel {
  if (model === "tenant_direct" || model === "included_in_rent" || model === "variable") return model;
  return "manager_billed";
}

/**
 * Whether the amount input is shown beside the picker.
 *
 * "Fixed amount" needs one because it IS the monthly charge. "Variable" shows
 * one too, but it is an ESTIMATE — a prospect still has to see roughly what
 * utilities run, and the lease quotes it for disclosure. Neither "Paid by
 * resident" nor "Included in rent" has a separate charge, so the input is
 * hidden for both.
 */
export function longTermUtilitiesEstimateRequired(model: UtilitiesPaymentModel | undefined): boolean {
  const picked = longTermUtilitiesPickerValue(model);
  return picked === "manager_billed" || picked === "variable";
}

/**
 * Whether the amount is a real charge or only an estimate.
 *
 * The one place that separates "Fixed amount" from "Variable": a fixed amount
 * is billed as-is every period, a variable one is a guide and the manager
 * raises the actual charge once usage is known. Everything that turns a listing
 * into money reads this rather than testing the model by hand.
 */
export function utilitiesAmountIsFixedCharge(model: UtilitiesPaymentModel | undefined): boolean {
  return longTermUtilitiesPickerValue(model) === "manager_billed";
}

/**
 * What the amount beside the picker IS, in the manager's words.
 *
 * The same input means two different things depending on the model, and the
 * difference is money: under "Fixed amount" it is the charge, under "Variable"
 * it is only a guide. One helper so every field that renders it says the same
 * thing.
 */
export function utilitiesAmountFieldNoun(model: UtilitiesPaymentModel | undefined): string {
  return longTermUtilitiesPickerValue(model) === "variable"
    ? "Estimated monthly utilities"
    : "Utilities amount";
}

export function normalizeUtilitiesPaymentModel(raw: unknown): UtilitiesPaymentModel {
  if (raw === "tenant_direct" || raw === "included_in_rent" || raw === "variable") return raw;
  return "manager_billed";
}

function formatEstimateSuffix(raw: string | undefined): string | null {
  const amount = parseMoneyAmount(raw ?? "");
  if (amount > 0) return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
  const t = raw?.trim();
  if (!t) return null;
  const cleaned = t.replace(/\/mo(nth)?\.?$/i, "").trim();
  return cleaned || null;
}

/** Renter-facing utilities line for a room (or entire-home primary room). */
export function formatUtilitiesListingLine(
  model: UtilitiesPaymentModel,
  estimateRaw?: string,
): string {
  const est = formatEstimateSuffix(estimateRaw);
  switch (model) {
    case "variable":
      // Never rendered as a flat "$X/mo" — that is the fixed-amount sentence,
      // and a prospect reading it would expect that exact bill every month.
      return est ? `Billed by usage (~${est}/mo typical)` : "Billed by usage";
    case "tenant_direct":
      return est ? `Tenant pays directly (~${est}/mo typical)` : "Tenant pays directly";
    case "included_in_rent":
      return "Included in rent";
    case "manager_billed":
    default:
      return est ? `${est}/mo est.` : "—";
  }
}

export function resolveRoomUtilitiesPaymentModel(room: ManagerRoomSubmission | undefined): UtilitiesPaymentModel {
  return normalizeUtilitiesPaymentModel(room?.utilitiesPaymentModel);
}

export function resolveEntireHomeUtilitiesPaymentModel(
  sub: Pick<ManagerListingSubmissionV1, "entireHomeUtilitiesPaymentModel" | "rooms">,
): UtilitiesPaymentModel {
  if (sub.entireHomeUtilitiesPaymentModel) {
    return normalizeUtilitiesPaymentModel(sub.entireHomeUtilitiesPaymentModel);
  }
  const primary = sub.rooms.find((r) => r.name.trim());
  return resolveRoomUtilitiesPaymentModel(primary);
}

export function resolveListingUtilitiesPaymentModel(
  sub: ManagerListingSubmissionV1 | undefined,
  room?: ManagerRoomSubmission | null,
): UtilitiesPaymentModel {
  if (!sub) return "manager_billed";
  if (room) return resolveRoomUtilitiesPaymentModel(room);
  if (isEntireHomeListing(sub)) return resolveEntireHomeUtilitiesPaymentModel(sub);
  return "manager_billed";
}

/**
 * The single utilities model shared by every listed room, or null when the listing
 * has no named rooms or its rooms disagree.
 */
export function resolveUniformRoomUtilitiesPaymentModel(
  sub: Pick<ManagerListingSubmissionV1, "rooms">,
): UtilitiesPaymentModel | null {
  const rooms = sub.rooms.filter((r) => r.name.trim());
  if (!rooms.length) return null;
  const models = [...new Set(rooms.map((r) => resolveRoomUtilitiesPaymentModel(r)))];
  return models.length === 1 ? models[0]! : null;
}

/**
 * One utilities model for the listing as a whole — the entire-home model, the model
 * every room agrees on, or the listing-level fallback when rooms differ. Shared by the
 * listing summary label and the lease utilities defaults so the two cannot drift.
 */
export function resolveAggregateUtilitiesPaymentModel(
  sub: ManagerListingSubmissionV1 | undefined,
): UtilitiesPaymentModel {
  if (!sub) return "manager_billed";
  if (isEntireHomeListing(sub)) return resolveEntireHomeUtilitiesPaymentModel(sub);
  return resolveUniformRoomUtilitiesPaymentModel(sub) ?? resolveListingUtilitiesPaymentModel(sub);
}

/**
 * The largest monthly utilities estimate this listing would actually bill residents through
 * the portal (0 when nothing is manager-billed or no estimate is set). Rooms must resolve to
 * manager_billed *uniformly*: `resolveAggregateUtilitiesPaymentModel` falls back to
 * manager_billed when rooms disagree, which is a display default, not a billing fact.
 */
export function aggregateBillableUtilitiesEstimate(sub: ManagerListingSubmissionV1 | undefined): number {
  if (!sub?.v) return 0;
  if (isEntireHomeListing(sub)) {
    if (!utilitiesAmountIsFixedCharge(resolveEntireHomeUtilitiesPaymentModel(sub))) return 0;
    const raws = [sub.entireHomeUtilitiesEstimate, sub.rooms.find((r) => r.name.trim())?.utilitiesEstimate];
    return raws.reduce<number>((max, raw) => Math.max(max, parseMoneyAmount(raw ?? "")), 0);
  }
  // `null` means the rooms DISAGREE, which is not a billing fact — it must not
  // fall through to the fixed-amount default the way an absent model does.
  const uniform = resolveUniformRoomUtilitiesPaymentModel(sub);
  if (uniform === null || !utilitiesAmountIsFixedCharge(uniform)) return 0;
  return sub.rooms
    .filter((r) => r.name.trim())
    .reduce<number>((max, room) => Math.max(max, utilitiesBillableMonthlyAmount(sub, room)), 0);
}

/**
 * The monthly utilities estimate the listing would still bill while the lease's per-utility
 * breakdown says nothing is the Resident's to pay — 0 when the two agree. The generated lease
 * quotes the estimate from the listing model, so a non-zero result means the signed document
 * and the recurring charge would tell the resident different things.
 */
export function leaseUtilitiesBillingConflictAmount(sub: ManagerListingSubmissionV1 | undefined): number {
  const lines = normalizeLeaseUtilities(sub?.leaseUtilities);
  if (!lines?.length || hasResidentPaidLeaseUtility(lines)) return 0;
  return aggregateBillableUtilitiesEstimate(sub);
}

/** Monthly utilities amount billable through the manager portal (0 when tenant pays directly or included). */
export function utilitiesBillableMonthlyAmount(
  sub: ManagerListingSubmissionV1 | undefined,
  room: ManagerRoomSubmission | null | undefined,
  estimateOverride?: string,
): number {
  if (estimateOverride?.trim()) return parseMoneyAmount(estimateOverride);
  const model = resolveListingUtilitiesPaymentModel(sub, room);
  // Variable utilities deliberately bill NOTHING on a recurring schedule. The
  // stored number is an estimate, and charging an estimate every month as if it
  // were metered usage would put a figure nobody measured on a resident's
  // ledger. The manager raises the real charge once usage is known.
  if (!utilitiesAmountIsFixedCharge(model)) return 0;
  const raw = room?.utilitiesEstimate?.trim() || sub?.entireHomeUtilitiesEstimate?.trim() || "";
  return parseMoneyAmount(raw);
}

/** Aggregate utilities summary for listing cards and bundle tables. */
export function utilitiesListingSummaryLabel(sub: ManagerListingSubmissionV1 | undefined): string {
  if (!sub?.v) return "—";
  if (isEntireHomeListing(sub)) {
    const model = resolveEntireHomeUtilitiesPaymentModel(sub);
    const est = sub.entireHomeUtilitiesEstimate ?? sub.rooms.find((r) => r.name.trim())?.utilitiesEstimate;
    return formatUtilitiesListingLine(model, est);
  }
  const rooms = sub.rooms.filter((r) => r.name.trim());
  if (!rooms.length) return "—";
  const model = resolveUniformRoomUtilitiesPaymentModel(sub);
  if (model) {
    if (model === "manager_billed") {
      const vals = rooms
        .map((r) => parseMoneyAmount(r.utilitiesEstimate ?? ""))
        .filter((x) => x > 0);
      if (!vals.length) return "—";
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      return lo === hi ? `$${lo.toFixed(2)}/mo est.` : `$${lo.toFixed(2)}–${hi.toFixed(2)}/mo est.`;
    }
    if (model === "variable") {
      const vals = rooms
        .map((r) => parseMoneyAmount(r.utilitiesEstimate ?? ""))
        .filter((x) => x > 0);
      if (!vals.length) return "Billed by usage";
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const range = lo === hi ? `~$${lo.toFixed(0)}/mo` : `~$${lo.toFixed(0)}–${hi.toFixed(0)}/mo`;
      return `Billed by usage (${range} typical)`;
    }
    if (model === "tenant_direct") {
      const vals = rooms
        .map((r) => parseMoneyAmount(r.utilitiesEstimate ?? ""))
        .filter((x) => x > 0);
      if (!vals.length) return "Tenant pays directly";
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const range = lo === hi ? `~$${lo.toFixed(0)}/mo` : `~$${lo.toFixed(0)}–${hi.toFixed(0)}/mo`;
      return `Tenant pays directly (${range} typical)`;
    }
    return "Included in rent";
  }
  return "Varies by room — see room details";
}
