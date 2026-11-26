"use client";

import { Button } from "@/components/ui/button";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import type { ResidentStaySummary } from "@/lib/resident-stay-summary";

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * "Your stay": what the resident owes, as plain fact rows (stay, deposit, additional charges,
 * total) and the ONE Pay that settles all of it in a single checkout. Display only - the figures
 * are `buildResidentStaySummary` over the server's charges, and Pay hands the same charge ids to
 * the existing multi-charge checkout.
 */
export function ResidentStaySummaryCard({
  summary,
  onPay,
}: {
  summary: ResidentStaySummary;
  onPay: () => void;
}) {
  if (summary.rows.length === 0) return null;
  return (
    <div className="mb-3" data-attr="resident-stay-summary">
      <RecordFactCard title="Your stay">
        {summary.rows.map((row) => (
          <RecordFactRow key={row.id} label={row.label} value={usd(row.cents)} />
        ))}
        <RecordFactRow label="Total due now" value={<span className="font-semibold">{usd(summary.totalDueCents)}</span>} />
        <div className="flex justify-end border-t border-border px-[var(--portal-card-padding,14px)] py-3">
          <Button
            type="button"
            variant="primary"
            className="max-md:w-full max-md:!h-11"
            data-attr="resident-stay-pay"
            onClick={onPay}
          >
            {`Pay ${usd(summary.payCents)}`}
          </Button>
        </div>
      </RecordFactCard>
    </div>
  );
}
