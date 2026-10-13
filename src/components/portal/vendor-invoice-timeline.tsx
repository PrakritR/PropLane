"use client";

import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD_COMPACT,
  PORTAL_TABLE_TR,
} from "@/components/portal/portal-data-table";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import { VendorTimelineState } from "@/components/portal/vendor-timeline-state";
import { safeFormatDateTime } from "@/lib/pacific-time";
import type { VendorInvoiceTimelineStep } from "@/lib/vendor-invoices";


/**
 * C161 — the invoice record's overview tab used to render only a plain
 * "$total · statusLabel" line, so a Rejected invoice read as an ordinary
 * terminal fact rather than the dead end it is. Steps come from
 * `vendorInvoiceTimeline` (`src/lib/vendor-invoices.ts`): Submitted →
 * Approved → Scheduled → Paid, or the short Submitted → Rejected branch.
 * Same visual shape as `VendorPayoutTimeline` (a detail-view table, where a
 * status `Badge` is allowed — this is not a list row).
 */
export function VendorInvoiceTimeline({
  steps,
  dataAttr = "vendor-invoice-timeline",
}: {
  steps: VendorInvoiceTimelineStep[];
  dataAttr?: string;
}) {
  return (
    <div className={PORTAL_DATA_TABLE_WRAP} data-attr={dataAttr}>
      <div className={PORTAL_DATA_TABLE_SCROLL}>
        <table className={PORTAL_DATA_TABLE}>
          <thead>
            <tr className={PORTAL_TABLE_HEAD_ROW}>
              <th className={`${MANAGER_TABLE_TH} text-left`}>Step</th>
              <th className={`${MANAGER_TABLE_TH} text-left`}>When</th>
              <th className={`${MANAGER_TABLE_TH} text-left`}>Details</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step) => {
              return (
                <tr key={step.id} className={PORTAL_TABLE_TR} data-attr={`${dataAttr}-step`} data-step={step.id} data-state={step.state}>
                  <td className={`${PORTAL_TABLE_TD_COMPACT} font-medium text-foreground`}>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {step.label}
                      <VendorTimelineState state={step.state} failedLabel="Rejected" />
                    </span>
                  </td>
                  <td className={`${PORTAL_TABLE_TD_COMPACT} whitespace-nowrap tabular-nums text-muted`}>
                    {safeFormatDateTime(step.at)}
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
