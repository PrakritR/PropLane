"use client";

import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
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
import type { VendorPayoutTimelineStep } from "@/lib/vendor-payout-timeline";


/**
 * Compact dated timeline of one vendor payout: invoice approved → payout created →
 * transfer sent → paid out / failed / skipped. Steps come from
 * `vendorPayoutTimeline` (`src/lib/vendor-payout-timeline.ts`); a step with no
 * stored instant shows "—" for its date rather than a guess.
 */
export function VendorPayoutTimeline({
  steps,
  title = "Payout timeline",
  subtitle,
  dataAttr = "vendor-payout-timeline",
}: {
  steps: VendorPayoutTimelineStep[];
  title?: string;
  subtitle?: string;
  dataAttr?: string;
}) {
  return (
    <PortalCollapsibleSection
      title={title}
      subtitle={subtitle}
      titleVariant="resident"
      bareSurface
      toggleDataAttr={`${dataAttr}-toggle`}
      contentClassName="pt-2"
    >
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
                        <VendorTimelineState state={step.state} failedLabel="Failed" />
                      </span>
                    </td>
                    <td className={`${PORTAL_TABLE_TD_COMPACT} whitespace-nowrap tabular-nums text-muted`}>
                      {safeFormatDateTime(step.at)}
                    </td>
                    <td className={`${PORTAL_TABLE_TD_COMPACT} break-words text-muted`}>
                      {step.detail ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </PortalCollapsibleSection>
  );
}
