/**
 * Pure vendor-matching SUGGESTION service for a single work order. Produces a
 * ranked shortlist of candidate vendors for the manager to review — it never
 * assigns a vendor, sends a notification, or writes anything. The manager
 * Approvals UI (Slice D) is what turns a suggestion into an actual assignment.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { vendorCapabilitiesMatchCategory } from "@/lib/work-order-taxonomy";

/** A vendor's work capabilities: self-selected `trades[]` if set, else the legacy single `trade`. */
function vendorCapabilities(vendor: ManagerVendorRow): string[] {
  return vendor.trades && vendor.trades.length > 0 ? vendor.trades : [vendor.trade];
}

/** Human-readable label for a vendor's capabilities, used in the match reason. */
function vendorCapabilityLabel(vendor: ManagerVendorRow): string {
  return vendorCapabilities(vendor).join(", ");
}

export type VendorMatchCandidate = {
  vendorId: string;
  vendorName: string;
  trade: string;
  /** ISO timestamp of this vendor's most recent work-order assignment, or null if never assigned. */
  lastAssignedAt: string | null;
  /** Short human-readable explanation of why this vendor was suggested. */
  reason: string;
};

export type SuggestVendorsOptions = {
  /**
   * The manager's other work orders, used to compute each candidate vendor's
   * most-recent assignment for fairness ranking. Defaults to empty (every
   * candidate ranks as "no prior assignments").
   */
  allWorkOrders?: DemoManagerWorkOrderRow[];
  /** Epoch ms used to phrase "Nd ago" in each reason. Defaults to Date.now(). */
  now?: number;
  /**
   * N006: this work order's property + trade preferred-vendor list
   * (`manager_vendor_preferences`), already ordered highest-priority first —
   * the caller resolves this from the database (see
   * `suggestVendorsForWorkOrderTool` in `src/lib/tools/domains/work-orders.ts`).
   * Consulted FIRST, in the given order, before the fairness ranking below.
   * A vendor id that doesn't match an active/eligible candidate is silently
   * skipped rather than surfaced.
   */
  preferredVendorIds?: readonly string[];
};

/**
 * Ranks active, trade-matched, scope-matched vendors for a work order.
 * Preferred vendors configured for this property + trade (N006) come first,
 * in their configured order; the rest are ranked by least-recently-assigned
 * (fairness), exactly as before. Returns [] when nothing matches — the
 * manager UI falls back to the full manual picker in that case.
 */
export function suggestVendorsForWorkOrder(
  workOrder: DemoManagerWorkOrderRow,
  vendors: ManagerVendorRow[],
  opts: SuggestVendorsOptions = {},
): VendorMatchCandidate[] {
  const category = workOrder.category;
  if (!category) return [];

  const now = opts.now ?? Date.now();
  const lastAssignedByVendorId = mostRecentAssignmentByVendorId(opts.allWorkOrders ?? []);

  const candidates = vendors.filter((vendor) => {
    if (vendor.active === false) return false;
    const ownedByManager = Boolean(workOrder.managerUserId) && vendor.managerUserId === workOrder.managerUserId;
    if (!ownedByManager && vendor.sharedWithManagers !== true) return false;
    if (!vendorCapabilitiesMatchCategory(vendorCapabilities(vendor), category)) return false;
    if (workOrder.propertyId && vendor.propertyIds && vendor.propertyIds.length > 0) {
      if (!vendor.propertyIds.includes(workOrder.propertyId)) return false;
    }
    return true;
  });
  const candidatesById = new Map(candidates.map((vendor) => [vendor.id, vendor]));

  const preferredIds = [...new Set((opts.preferredVendorIds ?? []).filter((id) => candidatesById.has(id)))];
  const preferredVendors = preferredIds.map((id) => candidatesById.get(id)!);
  const preferredSet = new Set(preferredIds);
  const restCandidates = candidates.filter((vendor) => !preferredSet.has(vendor.id));

  const preferredResults = preferredVendors.map((vendor, index) => ({
    vendorId: vendor.id,
    vendorName: vendor.name,
    trade: vendor.trade,
    lastAssignedAt: lastAssignedByVendorId.get(vendor.id) ?? null,
    reason: buildPreferredReason(index),
  }));

  const restResults = restCandidates
    .map((vendor) => ({ vendor, lastAssignedAt: lastAssignedByVendorId.get(vendor.id) ?? null }))
    .sort((a, b) => compareByRecency(a.lastAssignedAt, b.lastAssignedAt) || a.vendor.name.localeCompare(b.vendor.name))
    .map(({ vendor, lastAssignedAt }) => ({
      vendorId: vendor.id,
      vendorName: vendor.name,
      trade: vendor.trade,
      lastAssignedAt,
      reason: buildReason(vendorCapabilityLabel(vendor), lastAssignedAt, now),
    }));

  return [...preferredResults, ...restResults];
}

function buildPreferredReason(rankIndex: number): string {
  return rankIndex === 0
    ? "your top preferred vendor for this property/trade"
    : `preferred vendor for this property/trade (#${rankIndex + 1})`;
}

function mostRecentAssignmentByVendorId(workOrders: DemoManagerWorkOrderRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const wo of workOrders) {
    if (!wo.vendorId || !wo.vendorAssignedAt) continue;
    const existing = out.get(wo.vendorId);
    if (!existing || wo.vendorAssignedAt > existing) {
      out.set(wo.vendorId, wo.vendorAssignedAt);
    }
  }
  return out;
}

/** Never-assigned vendors first (fairness), then oldest assignment first. */
function compareByRecency(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function buildReason(trade: string, lastAssignedAt: string | null, now: number): string {
  if (!lastAssignedAt) return "no prior assignments";
  return `matches ${trade} · last assigned ${daysAgoLabel(lastAssignedAt, now)}`;
}

function daysAgoLabel(isoDate: string, now: number): string {
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return "previously";
  const days = Math.max(0, Math.floor((now - then) / (1000 * 60 * 60 * 24)));
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}
