"use client";

/**
 * VD52 — the payment detail page's banking-aware status timeline: Paid by
 * manager → In your PropLane balance → Transferred to your account →
 * Withdrawn. Same visual shape as `VendorInvoiceTimeline` (a detail-view
 * table, where a status `Badge` is allowed), but built for
 * `VendorPaymentTimelineStep` (`vendor-payments.ts`'s
 * `vendorPaymentStatusTimeline`), which never claims a step happened at an
 * exact, unknowable instant — see that function's own doc comment for what
 * "done" means for the last two steps.
 */
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD_COMPACT,
  PORTAL_TABLE_TR,
} from "@/components/portal/portal-data-table";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import { Badge } from "@/components/ui/badge";
import type { VendorPaymentTimelineState, VendorPaymentTimelineStep } from "@/lib/vendor-payments";

const STATE_BADGE: Record<VendorPaymentTimelineState, { tone: "confirmed" | "pending" | "neutral"; label: string }> = {
  done: { tone: "confirmed", label: "Done" },
  pending: { tone: "pending", label: "Pending" },
  skipped: { tone: "neutral", label: "Skipped" },
};

export function VendorPaymentStatusTimeline({
  steps,
  dataAttr = "vendor-payment-status-timeline",
}: {
  steps: VendorPaymentTimelineStep[];
  dataAttr?: string;
}) {
  return (
    <div className={PORTAL_DATA_TABLE_WRAP} data-attr={dataAttr}>
      <div className={PORTAL_DATA_TABLE_SCROLL}>
        <table className={PORTAL_DATA_TABLE}>
          <thead>
            <tr className={PORTAL_TABLE_HEAD_ROW}>
              <th className={`${MANAGER_TABLE_TH} text-left`}>Step</th>
              <th className={`${MANAGER_TABLE_TH} text-left`}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step) => {
              const badge = STATE_BADGE[step.state];
              return (
                <tr key={step.id} className={PORTAL_TABLE_TR} data-attr={`${dataAttr}-step`} data-step={step.id} data-state={step.state}>
                  <td className={`${PORTAL_TABLE_TD_COMPACT} font-medium text-foreground`}>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {step.label}
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </span>
                  </td>
                  <td className={`${PORTAL_TABLE_TD_COMPACT} break-words text-muted`}>{step.detail ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
