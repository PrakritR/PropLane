import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";

/** Vendor Services tabs — same row as manager Tours (Pending / Upcoming / Past). */
export type VendorWorkOrderTab = "pending" | "upcoming" | "past";

export const VENDOR_WORK_ORDER_TAB_ORDER: VendorWorkOrderTab[] = ["pending", "upcoming", "past"];

export const VENDOR_WORK_ORDER_TAB_LABELS: Record<VendorWorkOrderTab, string> = {
  pending: "Pending",
  upcoming: "Upcoming",
  past: "Past",
};

/** Old Quote / Site visit / Scheduled / Completed URLs. */
export const VENDOR_WORK_ORDER_LEGACY_TABS: Record<string, VendorWorkOrderTab> = {
  quote: "pending",
  tour: "pending",
  scheduled: "upcoming",
  completed: "past",
};

/** Consultation booked; vendor still owes labor price + work date. */
export function isPricingPendingBid(bid: WorkOrderBid | undefined): boolean {
  return Boolean(
    bid &&
      bid.quoteMode === "after_consultation" &&
      bid.consultationVisitAt &&
      bid.amountCents == null &&
      bid.status === "submitted",
  );
}

export function parseVendorWorkOrderTab(raw: string | undefined | null): VendorWorkOrderTab {
  if (raw && (VENDOR_WORK_ORDER_TAB_ORDER as readonly string[]).includes(raw)) {
    return raw as VendorWorkOrderTab;
  }
  if (raw && VENDOR_WORK_ORDER_LEGACY_TABS[raw]) return VENDOR_WORK_ORDER_LEGACY_TABS[raw]!;
  return "pending";
}

/**
 * Classify a vendor work order into the Services tab it belongs in.
 *
 * - **Pending** — quote due or site visit booked and still unpriced.
 * - **Upcoming** — accepted / scheduled work still on the calendar.
 * - **Past** — completed (paid or awaiting manager sign-off).
 */
export function vendorWorkOrderTab(
  row: DemoManagerWorkOrderRow,
  bid?: WorkOrderBid,
): VendorWorkOrderTab {
  if (row.bucket === "completed") return "past";
  if (isPricingPendingBid(bid) || row.biddingOpen) return "pending";
  return "upcoming";
}

export function vendorWorkOrderPhaseLabel(row: DemoManagerWorkOrderRow, bid?: WorkOrderBid): string | null {
  const tab = vendorWorkOrderTab(row, bid);
  if (tab === "pending") {
    if (isPricingPendingBid(bid)) return "Price after visit";
    if (!bid) return "Needs quote";
    if (bid.quoteMode === "after_consultation" && !bid.consultationVisitAt) return "Book site visit";
    return "Awaiting manager";
  }
  if (tab === "upcoming") {
    if (row.automationStatus === "vendor_marked_done") return "Awaiting approval";
    if (row.automationStatus === "paid") return "Paid";
    if (bid?.status === "accepted") return "Accepted";
    if ((row.vendorCostCents ?? 0) > 0 && !row.biddingOpen) return "Fixed price";
    return row.scheduledAtIso ? "Visit booked" : "In progress";
  }
  if (row.automationStatus === "paid") return "Paid";
  if (row.automationStatus === "vendor_marked_done") return "Awaiting approval";
  return null;
}
