"use client";

import type { ReactNode } from "react";
import { CalendarDays, Check, Clock, Plus, Receipt, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { cn } from "@/lib/utils";
import { formatServiceMoney } from "@/lib/manager-service-workflow";
import type { ServiceStage, VendorRequestRow } from "@/lib/work-order-bid-cycle";

/** `Mon, Oct 5, 4:00 PM` - a visit or bid time as one short fact. */
function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The stage bar: Pending · Bids requested · Bid approved · Scheduled · Completed · Paid. */
export function ServiceStageBar({ stages }: { stages: readonly ServiceStage[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs" aria-label="Service stages" data-attr="service-stage-bar">
      {stages.map((stage, index) => (
        <li key={stage.id} className="inline-flex items-center gap-1" aria-current={stage.state === "current" ? "step" : undefined}>
          {index > 0 ? <span aria-hidden className="mx-1 h-px w-4 bg-border" /> : null}
          <span
            aria-hidden
            className={cn(
              "grid size-4 place-items-center rounded-full border text-[9px]",
              stage.state === "done" && "border-primary bg-primary text-primary-foreground",
              stage.state === "current" && "border-primary text-primary",
              stage.state === "todo" && "border-border text-transparent",
            )}
          >
            {stage.state === "done" ? <Check className="size-3" strokeWidth={3} /> : null}
          </span>
          <span className={cn(stage.state === "current" ? "font-semibold text-foreground" : "text-muted")}>{stage.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** What the row says about where this vendor is, as plain glyph facts (never a pill). */
function requestFacts(row: VendorRequestRow) {
  const facts: ReactNode[] = [];
  const fee = row.visitFeeCents > 0 ? ` · ${formatServiceMoney(row.visitFeeCents)} fee` : "";
  switch (row.state) {
    case "requested":
      facts.push(<PortalRowFact key="s" icon={Clock}>Requested · waiting</PortalRowFact>);
      break;
    case "estimate":
      facts.push(<PortalRowFact key="s" icon={Receipt}>Estimate {formatServiceMoney(row.estimateCents)}</PortalRowFact>);
      break;
    case "visit_booked":
    case "visit_done":
      facts.push(
        <PortalRowFact key="s" icon={CalendarDays}>
          {row.state === "visit_done" ? "Visit done" : "Visit"} {shortWhen(row.visitAt)}
          {fee}
        </PortalRowFact>,
      );
      break;
    case "bid":
    case "approved":
      facts.push(
        <PortalRowFact key="s" icon={Receipt}>
          Bid {formatServiceMoney(row.bidAmountCents)}
          {row.bidMaterialsCents > 0 ? ` + ${formatServiceMoney(row.bidMaterialsCents)} materials` : ""}
        </PortalRowFact>,
      );
      if (row.proposedTime) facts.push(<PortalRowFact key="t" icon={CalendarDays}>{shortWhen(row.proposedTime)}</PortalRowFact>);
      break;
    case "declined":
      facts.push(<PortalRowFact key="s" icon={Clock}>Declined</PortalRowFact>);
      break;
  }
  if (row.estimateCents != null && (row.state === "bid" || row.state === "visit_done" || row.state === "visit_booked")) {
    facts.push(<PortalRowFact key="e" icon={Receipt}>Estimate {formatServiceMoney(row.estimateCents)}</PortalRowFact>);
  }
  return facts;
}

/**
 * Vendor & schedule: the stage bar and one Payments-row-style row per requested vendor
 * (offers + bids). Approve bid exists only on a row with a SUBMITTED BID - disabled, with an
 * accessible name saying why, on every other row. An estimate is a number on the row, never a thing
 * to approve.
 */
export function ServiceVendorCycleSection({
  stages,
  requests,
  assignValue,
  assignGroups,
  approvingBidId,
  onAssign,
  onRequestMore,
  onApprove,
  onMessage,
  onRemove,
}: {
  stages: readonly ServiceStage[];
  requests: readonly VendorRequestRow[];
  assignValue: string;
  assignGroups: Array<{ label: string; options: Array<{ value: string; label: string }> }>;
  approvingBidId: string | null;
  onAssign: (value: string) => void;
  onRequestMore: () => void;
  onApprove: (row: VendorRequestRow) => void;
  onMessage: (row: VendorRequestRow) => void;
  onRemove: (row: VendorRequestRow) => void;
}) {
  const visible = requests.filter((r) => r.state !== "declined" || r.bidId);
  return (
    <div className="space-y-4 px-3 pb-6 sm:px-4" data-attr="service-vendor-cycle">
      <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-3">
        <ServiceStageBar stages={stages} />
        <div className="flex items-end gap-2">
          <FieldSingleSelect
            label="Assign"
            value={assignValue}
            groups={assignGroups}
            onChange={onAssign}
            placeholder="Request bids, or pick who does it"
            dataAttr="service-assign-select"
            wrapperClassName="min-w-0 flex-1"
          />
          <PortalIconAction
            icon={Plus}
            label="Request more vendors"
            ring
            ringPrimary
            data-attr="service-request-more-vendors"
            onClick={onRequestMore}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <PortalListEmptyCard title="No vendors requested yet" workspaceAware={false} dataAttr="service-vendor-requests-empty" />
      ) : (
        <div data-attr="service-vendor-requests">
          {visible.map((row) => {
            const total = row.bidTotalCents;
            const figure = total != null ? formatServiceMoney(total) : row.estimateCents != null ? formatServiceMoney(row.estimateCents) : undefined;
            const figureLabel = total != null ? "Bid" : row.estimateCents != null ? "Estimate" : undefined;
            const approving = approvingBidId === row.bidId;
            return (
              <PortalApplicantRecordRow
                key={row.key}
                name={row.vendorName}
                tileIcon={Wrench}
                address={row.note && row.state !== "declined" ? row.note : undefined}
                facts={<>{requestFacts(row)}</>}
                amount={figure}
                amountSubLabel={figureLabel}
                dataAttr="service-vendor-request-row"
                actions={
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="primary"
                      data-attr="service-approve-bid"
                      className="h-7 rounded-full px-3 text-xs"
                      disabled={!row.canApprove || approving}
                      aria-label={row.canApprove ? `Approve bid from ${row.vendorName}` : `Approve bid - ${row.vendorName} has not submitted a bid`}
                      title={row.canApprove ? undefined : "No bid submitted yet"}
                      onClick={() => onApprove(row)}
                    >
                      {approving ? "Approving…" : "Approve bid"}
                    </Button>
                    <RowActionsMenu
                      label={row.vendorName}
                      items={[
                        { id: "message", label: "Message", onSelect: () => onMessage(row), dataAttr: "service-vendor-request-message" },
                        row.state === "approved"
                          ? null
                          : { id: "remove", label: "Remove request", danger: true, onSelect: () => onRemove(row), dataAttr: "service-vendor-request-remove" },
                      ]}
                    />
                  </div>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
