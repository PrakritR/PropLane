"use client";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";

type ThreadEvent = { id: string; label: string; at?: string };

function buildServiceThreadEvents(row: DemoManagerWorkOrderRow, bids: WorkOrderBid[]): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  if (row.biddingOpenedAt) events.push({ id: "published", label: "Sent to vendors", at: row.biddingOpenedAt });
  for (const bid of bids) {
    if (bid.status === "submitted" || bid.status === "accepted") {
      events.push({ id: `bid-${bid.id}`, label: "Quote sent", at: bid.createdAt });
    }
  }
  if (row.vendorAssignedAt) events.push({ id: "hired", label: "Hired", at: row.vendorAssignedAt });
  if (row.scheduledAtIso) events.push({ id: "scheduled", label: "Scheduled", at: row.scheduledAtIso });
  if (row.vendorMarkedDoneAt) events.push({ id: "done", label: "Marked done", at: row.vendorMarkedDoneAt });
  if (row.automationStatus === "vendor_marked_done") {
    events.push({ id: "invoice", label: "Invoice sent" });
  }
  if (row.automationStatus === "paid" || row.paidAt) {
    events.push({ id: "paid", label: "Paid", at: row.paidAt });
  }
  return events;
}

export function ServiceWorkOrderThreadEvents({
  row,
  bids,
}: {
  row: DemoManagerWorkOrderRow;
  bids: WorkOrderBid[];
}) {
  const events = buildServiceThreadEvents(row, bids);
  if (events.length === 0) return null;
  return (
    <div className="space-y-2 px-3 pb-2 sm:px-4" data-attr="service-thread-events">
      {events.map((event) => (
        <p
          key={event.id}
          className="text-center text-[11px] font-medium uppercase tracking-wide text-muted"
        >
          {event.label}
        </p>
      ))}
    </div>
  );
}
