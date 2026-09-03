import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { hasResidentPaidLeaseUtility, normalizeLeaseUtilities } from "@/lib/lease-utilities";
import { parseMoneyAmount } from "@/lib/parse-money";

/** How utilities are paid for a listed room or entire-home lease. */
export type UtilitiesPaymentModel = "manager_billed" | "tenant_direct" | "included_in_rent";

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
  { id: "tenant_direct", label: "Paid by resident" },
  { id: "included_in_rent", label: "Included in rent" },
] as const;

export function longTermUtilitiesPickerValue(model: UtilitiesPaymentModel | undefined): UtilitiesPaymentModel {
  if (model === "tenant_direct" || model === "included_in_rent") return model;
  return "manager_billed";
}

/** Only "Fixed amount" (manager-billed) needs an amount. Both "Paid by resident" and
 *  "Included in rent" have no separate utilities charge, so the amount input is hidden. */
export function longTermUtilitiesEstimateRequired(model: UtilitiesPaymentModel | undefined): boolean {
  return longTermUtilitiesPickerValue(model) === "manager_billed";
}

export function normalizeUtilitiesPaymentModel(raw: unknown): UtilitiesPaymentModel {
  if (raw === "tenant_direct" || raw === "included_in_rent") return raw;
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
    if (resolveEntireHomeUtilitiesPaymentModel(sub) !== "manager_billed") return 0;
    const raws = [sub.entireHomeUtilitiesEstimate, sub.rooms.find((r) => r.name.trim())?.utilitiesEstimate];
    return raws.reduce<number>((max, raw) => Math.max(max, parseMoneyAmount(raw ?? "")), 0);
  }
  if (resolveUniformRoomUtilitiesPaymentModel(sub) !== "manager_billed") return 0;
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
  if (model !== "manager_billed") return 0;
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
