"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, Clock, Receipt, UserPlus, UserRound, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordBandFilter, RecordListBand } from "@/components/portal/record-list-band";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { cn } from "@/lib/utils";
import { formatServiceMoney } from "@/lib/manager-service-workflow";
import { CYCLE_TAB_IDS, CYCLE_TAB_LABEL, cycleTabForRow, type CycleTabId, type ServiceStageId, type StageBarItem, type VendorRequestRow } from "@/lib/work-order-bid-cycle";

/** `Mon, Oct 5, 4:00 PM` - a visit or bid time as one short fact. */
function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The compact progress line: one thin segment per stage (filled up to the current one) and the
 * current stage's name with its place in the cycle. It replaces the old row of stage radios; the
 * stages themselves are the band's tabs.
 */
export function ServiceProgressLine({ stages }: { stages: readonly StageBarItem[] }) {
  const currentIdx = Math.max(0, stages.findIndex((stage) => stage.state === "current"));
  const current = stages[currentIdx];
  if (!current) return null;
  return (
    <div className="mb-3 flex items-center gap-3 px-1" data-attr="service-progress-line" role="group" aria-label={`Stage: ${current.label}`}>
      <div className="flex min-w-0 flex-1 gap-1" aria-hidden>
        {stages.map((stage) => (
          <span key={stage.id} className={cn("h-1 flex-1 rounded-full", stage.state === "todo" ? "bg-border" : "bg-primary")} />
        ))}
      </div>
      <span className="shrink-0 text-xs font-semibold text-foreground">
        {current.label} · {currentIdx + 1} of {stages.length}
      </span>
    </div>
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

const tabLabel = (id: CycleTabId) => CYCLE_TAB_LABEL[id];

/** The two icons every Vendor & schedule / add-on cycle band carries at its top right. */
function AssignIcon({ onClick }: { onClick: () => void }) {
  return <PortalIconAction icon={UserPlus} label="Assign" data-attr="service-assign-open" onClick={onClick} />;
}

/**
 * Vendor & schedule: the standard band (the cycle as tabs with counts - Requested · Estimates ·
 * Visits · Bids · Approved · Scheduled · Completed · Paid - search, the vendor Filter, the Assign
 * icon and the round +), the compact progress line, then one Payments-row-style row per requested
 * vendor under the tab its row has got to. Approve bid exists only on a row with a SUBMITTED BID -
 * disabled, with an accessible name saying why, on every other row. An estimate is a number on the
 * row, never a thing to approve.
 */
export function ServiceVendorCycleSection({
  stages,
  currentId,
  requests,
  approvingBidId,
  onOpenAssign,
  onAddVendors,
  onApprove,
  onMessage,
  onRemove,
  emptyTitle = "No vendors requested yet",
  lead,
}: {
  stages: readonly StageBarItem[];
  /** The service's current stage; the tab it maps to opens first. */
  currentId: ServiceStageId;
  requests: readonly VendorRequestRow[];
  approvingBidId: string | null;
  /** The UserPlus icon: opens the Assign popup. */
  onOpenAssign: () => void;
  /** The round +: add more vendors to the request (opens the same popup on "Request bids"). */
  onAddVendors: () => void;
  onApprove: (row: VendorRequestRow) => void;
  onMessage: (row: VendorRequestRow) => void;
  onRemove: (row: VendorRequestRow) => void;
  emptyTitle?: string;
  /** Cards between the band and the rows (the assigned vendor, PropLane's suggestion). */
  lead?: ReactNode;
}) {
  const initialTab = (CYCLE_TAB_IDS as readonly string[]).includes(currentId) ? (currentId as CycleTabId) : "requested";
  const [tab, setTab] = useState<CycleTabId>(initialTab);
  const [prevCurrent, setPrevCurrent] = useState(currentId);
  if (currentId !== prevCurrent) {
    setPrevCurrent(currentId);
    setTab(initialTab);
  }
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const placed = useMemo(() => requests.map((row) => ({ row, tab: cycleTabForRow(row, currentId) })), [requests, currentId]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(CYCLE_TAB_IDS.map((id) => [id, 0])) as Record<CycleTabId, number>;
    for (const entry of placed) c[entry.tab] += 1;
    return c;
  }, [placed]);
  const vendorOptions = useMemo(
    () => [...new Map(requests.map((r) => [r.vendorDirectoryId ?? r.vendorUserId ?? r.key, r.vendorName])).entries()].map(([value, label]) => ({ value, label })),
    [requests],
  );
  const shown = useMemo(
    () =>
      placed
        .filter((entry) => entry.tab === tab)
        .filter((entry) => !vendorFilter || (entry.row.vendorDirectoryId ?? entry.row.vendorUserId ?? entry.row.key) === vendorFilter)
        .filter((entry) => matchesPortalListSearch(search, entry.row.vendorName, entry.row.note ?? ""))
        .map((entry) => entry.row),
    [placed, tab, vendorFilter, search],
  );
  return (
    <RecordListBand
      dataAttr="service-vendor-cycle"
      ariaLabel="Service stage"
      tabs={CYCLE_TAB_IDS.map((id) => ({ id, label: tabLabel(id), count: counts[id] }))}
      activeId={tab}
      onChange={(id) => setTab(id as CycleTabId)}
      search={{ value: search, onChange: setSearch, placeholder: "Search vendors" }}
      actions={
        <>
          <RecordBandFilter
            dataAttr="service-vendor-cycle"
            fields={vendorOptions.length > 0 ? [{ id: "vendor", label: "Vendor", anyLabel: "Any vendor", value: vendorFilter, options: vendorOptions, onChange: setVendorFilter }] : []}
          />
          <AssignIcon onClick={onOpenAssign} />
        </>
      }
      plus={{ label: "Add vendors", onClick: onAddVendors, dataAttr: "service-request-more-vendors" }}
      isEmpty={shown.length === 0}
      emptyTitle={search.trim() || vendorFilter ? "No vendors match" : requests.length === 0 ? emptyTitle : `No vendors in ${tabLabel(tab).toLowerCase()}`}
      middle={
        <>
          {lead}
          <ServiceProgressLine stages={stages} />
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

/**
 * Vendor & schedule for an add-on service request. It has no vendors (they cannot take add-ons), so
 * the band's tabs are its own cycle - Pending · Assigned · Scheduled · Completed · Paid - and the one
 * row under the current tab is whoever is handling it.
 */
export function AddOnCycleSection({
  stages,
  currentId,
  assignee,
  onOpenAssign,
}: {
  stages: readonly StageBarItem[];
  currentId: string;
  assignee: { name: string } | null;
  onOpenAssign: () => void;
}) {
  const tabs = stages.map((stage) => ({ id: stage.id, label: stage.label }));
  const [tab, setTab] = useState(currentId);
  const [prevCurrent, setPrevCurrent] = useState(currentId);
  if (currentId !== prevCurrent) {
    setPrevCurrent(currentId);
    setTab(currentId);
  }
  const [search, setSearch] = useState("");
  const rowsHere = assignee && tab === currentId && currentId !== "pending" && currentId !== "declined" ? [assignee] : [];
  const shown = rowsHere.filter((a) => matchesPortalListSearch(search, a.name));
  return (
    <RecordListBand
      dataAttr="service-vendor-cycle"
      ariaLabel="Service stage"
      tabs={tabs.map((t) => ({ ...t, count: assignee && t.id === currentId && currentId !== "pending" && currentId !== "declined" ? 1 : 0 }))}
      activeId={tab}
      onChange={setTab}
      search={{ value: search, onChange: setSearch, placeholder: "Search team" }}
      actions={<AssignIcon onClick={onOpenAssign} />}
      isEmpty={shown.length === 0}
      emptyTitle={search.trim() ? "No team members match" : assignee ? "Nobody in this stage" : "No vendors on this service"}
      middle={<ServiceProgressLine stages={stages} />}
    >
      {shown.map((a) => (
        <PortalApplicantRecordRow
          key={a.name}
          name={a.name}
          tileIcon={UserRound}
          facts={<PortalRowFact icon={Clock}>{stages.find((stage) => stage.state === "current")?.label ?? "Assigned"}</PortalRowFact>}
          dataAttr="service-vendor-request-row"
        />
      ))}
    </RecordListBand>
  );
}
