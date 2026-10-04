"use client";

import { CalendarDays, Repeat } from "lucide-react";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import type { ServiceIncomingRow } from "@/lib/service-incoming-payments";

/**
 * The resident's charges for one service, drawn with the Payments page's own row (tile, title,
 * place line, glyph facts, figure). A recurring add-on's cadence is a fact on its fee row.
 */
export function ServiceIncomingPaymentsList({ rows }: { rows: readonly ServiceIncomingRow[] }) {
  if (rows.length === 0) {
    return <PortalListEmptyCard title="No charges for this service" workspaceAware={false} dataAttr="service-incoming-payments-empty" />;
  }
  return (
    <div className="px-3 pb-6 sm:px-4" data-attr="service-incoming-payments">
      {rows.map(({ row, recurringLabel }) => (
        <PortalApplicantRecordRow
          key={row.id}
          name={row.residentName || "Resident"}
          address={[row.chargeTitle, row.propertyName].filter(Boolean).join(" · ")}
          facts={
            <>
              {row.dueDate ? <PortalRowFact icon={CalendarDays}>{row.dueDate}</PortalRowFact> : null}
              {recurringLabel ? <PortalRowFact icon={Repeat}>{recurringLabel}</PortalRowFact> : null}
            </>
          }
          amount={row.lineAmount}
          amountTone={row.bucket === "paid" ? "ok" : row.bucket === "overdue" ? "bad" : undefined}
          dataAttr="service-incoming-payment-row"
        />
      ))}
    </div>
  );
}
