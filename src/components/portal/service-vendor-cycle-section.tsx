"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, Check, Clock, Receipt, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { RecordListBand } from "@/components/portal/record-list-band";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { cn } from "@/lib/utils";
import { formatServiceMoney } from "@/lib/manager-service-workflow";
import type { StageBarItem, VendorRequestRow } from "@/lib/work-order-bid-cycle";

/** `Mon, Oct 5, 4:00 PM` - a visit or bid time as one short fact. */
function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The stage bar: Pending · Bids requested · Bid approved · Scheduled · Completed · Paid. */
export function ServiceStageBar({ stages }: { stages: readonly StageBarItem[] }) {
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

type CycleTab = "requested" | "bids" | "approved";
const CYCLE_TABS: Array<{ id: CycleTab; label: string }> = [
  { id: "requested", label: "Requested" },
  { id: "bids", label: "Bids" },
  { id: "approved", label: "Approved" },
];
const tabOf = (row: VendorRequestRow): CycleTab => (row.state === "bid" ? "bids" : row.state === "approved" ? "approved" : "requested");

/**
 * Vendor & schedule: the standard list band (Requested · Bids · Approved, search, and the round +
 * to request vendors or assign), then the stage bar with Assign, then one Payments-row-style row
 * per requested vendor. Approve bid exists only on a row with a SUBMITTED BID - disabled, with an
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
  plus,
  onApprove,
  onMessage,
  onRemove,
  emptyTitle = "No vendors requested yet",
  lead,
}: {
  stages: readonly StageBarItem[];
  requests: readonly VendorRequestRow[];
  assignValue: string;
  assignGroups: Array<{ label: string; options: Array<{ value: string; label: string }> }>;
  approvingBidId: string | null;
  onAssign: (value: string) => void;
  /** The band's round +: request more vendors (maintenance) or assign (an add-on). */
  plus?: { label: string; onClick: () => void };
  onApprove: (row: VendorRequestRow) => void;
  onMessage: (row: VendorRequestRow) => void;
  onRemove: (row: VendorRequestRow) => void;
  emptyTitle?: string;
  /** Cards between the band and the stage card (the assigned vendor, PropLane's suggestion). */
  lead?: ReactNode;
}) {
  const [tab, setTab] = useState<CycleTab>("requested");
  const [search, setSearch] = useState("");
  const counts = useMemo(() => {
    const c: Record<CycleTab, number> = { requested: 0, bids: 0, approved: 0 };
    for (const row of requests) c[tabOf(row)] += 1;
    return c;
  }, [requests]);
  const shown = useMemo(
    () => requests.filter((row) => tabOf(row) === tab && matchesPortalListSearch(search, row.vendorName, row.note ?? "")),
    [requests, tab, search],
  );
  return (
    <RecordListBand
      dataAttr="service-vendor-cycle"
      ariaLabel="Vendor request status"
      tabs={CYCLE_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onChange={(id) => setTab(id as CycleTab)}
      search={{ value: search, onChange: setSearch, placeholder: "Search vendors" }}
      plus={plus ? { ...plus, dataAttr: "service-request-more-vendors" } : undefined}
      isEmpty={shown.length === 0}
      emptyTitle={search.trim() ? "No vendors match" : requests.length === 0 ? emptyTitle : tab === "requested" ? "No requests waiting" : tab === "bids" ? "No bids yet" : "No approved bid"}
      middle={
        <>
        {lead}
        <div className="mb-3 space-y-3 rounded-xl border border-border bg-card px-4 py-3" data-attr="service-stage-card">
          <ServiceStageBar stages={stages} />
          <FieldSingleSelect
            label="Assign"
            value={assignValue}
            groups={assignGroups}
            onChange={onAssign}
            placeholder="Request bids, or pick who does it"
            dataAttr="service-assign-select"
          />
        </div>
        </>
      }
    >
      {shown.map((row) => {
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
    </RecordListBand>
  );
}
