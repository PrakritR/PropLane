/**
 * The Activity tab of a service: what happened, newest first, from the record's own stamps.
 * Pure - nothing is invented, and an event with no timestamp is simply absent.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import { safeFormatDateTime } from "@/lib/pacific-time";

export type ServiceActivityEvent = { id: string; label: string; timestamp: string; at: number };

function event(id: string, label: string, iso: string | undefined | null): ServiceActivityEvent | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return { id, label, timestamp: safeFormatDateTime(iso), at };
}

function newestFirst(events: Array<ServiceActivityEvent | null>): ServiceActivityEvent[] {
  return events.filter((e): e is ServiceActivityEvent => e !== null).sort((a, b) => b.at - a.at);
}

export function workOrderActivityEvents(row: DemoManagerWorkOrderRow): ServiceActivityEvent[] {
  return newestFirst([
    event("requested-bids", "Bids requested", row.biddingOpenedAt),
    event("bid-approved", "Bid approved", row.biddingResolvedAt),
    event("vendor-assigned", row.vendorName ? `${row.vendorName} assigned` : "Vendor assigned", row.vendorAssignedAt),
    event("scheduled", "Visit scheduled", row.scheduledAtIso),
    event("marked-done", "Marked done", row.vendorMarkedDoneAt),
    event("completed", "Completed", row.completedAt),
    event("paid", "Paid", row.paidAt),
  ]);
}

export function addOnActivityEvents(req: ServiceRequest): ServiceActivityEvent[] {
  return newestFirst([
    event("requested", "Requested", req.requestedAt),
    event("approved", "Approved", req.approvedAt),
    event("denied", "Declined", req.deniedAt),
    event("service-paid", "Service fee paid", req.servicePaidAt),
    event("deposit-paid", "Deposit paid", req.depositPaidAt),
    event("returned", "Returned", req.returnedAt),
  ]);
}
