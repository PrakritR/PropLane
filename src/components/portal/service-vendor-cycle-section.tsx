"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, Clock, Receipt, Scale, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordBandFilter, RecordListBand } from "@/components/portal/record-list-band";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { formatServiceMoney } from "@/lib/manager-service-workflow";
import {
  SERVICE_STAGE_LABEL,
  SERVICE_STAGE_TABS,
  VENDOR_ANSWER_TABS,
  formatServiceWhen,
  vendorAnswerGroup,
  vendorRequestFact,
  type ServiceStage,
  type VendorAnswerGroup,
} from "@/lib/service-lifecycle";
import { compareBids, type VendorRequestRow } from "@/lib/work-order-bid-cycle";

/** Open the Vendors section on a given tab, optionally in the side-by-side compare view (the header's Compare bids). */
export type VendorsIntent = { tab?: VendorAnswerGroup; compare?: boolean; nonce: number };

const FACT_ICON: Record<VendorAnswerGroup, typeof Clock> = {
  requested: Clock,
  estimates: Receipt,
  bids: Receipt,
  approved: Receipt,
  declined: Clock,
};

const EMPTY_TITLE: Record<VendorAnswerGroup, string> = {
  requested: "No vendors waiting to answer",
  estimates: "No estimates yet",
  bids: "No bids yet",
  approved: "No bid approved yet",
  declined: "Nobody declined",
};

/** The tab a service's Vendors section opens on: where the most useful answers are. */
function firstTab(counts: Record<VendorAnswerGroup, number>): VendorAnswerGroup {
  for (const id of ["bids", "estimates", "requested", "approved", "declined"] as const) if (counts[id] > 0) return id;
  return "requested";
}

function CompareCards({
  rows,
  approvingBidId,
  onApprove,
}: {
  rows: readonly VendorRequestRow[];
  approvingBidId: string | null;
  onApprove: (row: VendorRequestRow) => void;
}) {
  const compared = compareBids(rows);
  const bidRows = new Map(rows.map((row) => [row.key, row]));
  return (
    <div className="grid grid-cols-1 gap-3 px-3 pb-4 sm:grid-cols-2 sm:px-4 lg:grid-cols-3" data-attr="service-bid-compare">
      {compared.map((bid) => {
        const source = bidRows.get(bid.key);
        const approving = approvingBidId === bid.bidId;
        const line = (label: string, value: string) => (
          <div className="flex justify-between gap-3 py-1 text-[13px] text-muted">
            <span>{label}</span>
            <span className="text-right text-foreground">{value}</span>
          </div>
        );
        return (
          <div
            key={bid.key}
            data-attr="service-bid-compare-card"
            className={`rounded-2xl border bg-card p-4 ${bid.lowest && compared.length > 1 ? "border-primary" : "border-border"}`}
          >
            <p className="text-[15px] font-semibold text-foreground">
              {bid.vendorName}
              {bid.lowest && compared.length > 1 ? <span className="ml-1.5 text-xs font-semibold text-primary">Lowest</span> : null}
            </p>
            <p className="my-1 text-[22px] font-bold tabular-nums text-foreground">{formatServiceMoney(bid.totalCents)}</p>
            {line("Labor", formatServiceMoney(bid.laborCents) || "—")}
            {line("Materials", formatServiceMoney(bid.materialsCents) || "$0")}
            {line("Earliest", formatServiceWhen(bid.earliestAt) || "—")}
            {line("Estimate first", formatServiceWhen(bid.estimateVisitAt) || "—")}
            <div className="mt-3">
              <Button
                type="button"
                variant="primary"
                data-attr="service-approve-bid"
                className="h-8 rounded-full px-4 text-xs"
                disabled={!bid.canApprove || approving || !source}
                aria-label={`Approve bid from ${bid.vendorName}`}
                onClick={() => source && onApprove(source)}
              >
                {approving ? "Approving…" : "Approve bid"}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Vendors section of a service: ONE band - Requested · Estimates · Bids · Approved · Declined
 * with counts, search, the vendor Filter, a Compare toggle on Bids and the round + (Request bids) -
 * then one row per requested vendor under the tab its answer has reached. Approve bid exists only on
 * a Bids row (an estimate is a number on the row, never a thing to approve); Compare lays every
 * submitted bid side by side.
 */
export function ServiceVendorCycleSection({
  stage,
  requests,
  approvingBidId,
  intent,
  onRequestBids,
  onApprove,
  onMessage,
  onRemove,
  emptyTitle = "No vendors on this service",
  lead,
}: {
  /** The service's stage; the tab resets when it changes (an approved bid moves the view to Approved). */
  stage: ServiceStage;
  requests: readonly VendorRequestRow[];
  approvingBidId: string | null;
  intent?: VendorsIntent | null;
  /** The round +: opens the Request bids / Assign popup on Request bids. */
  onRequestBids: () => void;
  onApprove: (row: VendorRequestRow) => void;
  onMessage: (row: VendorRequestRow) => void;
  onRemove: (row: VendorRequestRow) => void;
  emptyTitle?: string;
  /** Cards between the band and the rows (the assigned vendor, PropLane's suggestion). */
  lead?: ReactNode;
}) {
  const counts = useMemo(() => {
    const c = Object.fromEntries(VENDOR_ANSWER_TABS.map(({ id }) => [id, 0])) as Record<VendorAnswerGroup, number>;
    for (const row of requests) c[vendorAnswerGroup(row.state)] += 1;
    return c;
  }, [requests]);
  const [tab, setTab] = useState<VendorAnswerGroup>(() => intent?.tab ?? (stage === "open" ? firstTab(counts) : "approved"));
  const [compare, setCompare] = useState(Boolean(intent?.compare));
  const [seen, setSeen] = useState({ stage, nonce: intent?.nonce ?? 0 });
  if (seen.stage !== stage || seen.nonce !== (intent?.nonce ?? 0)) {
    setSeen({ stage, nonce: intent?.nonce ?? 0 });
    setTab(intent?.tab ?? (stage === "open" ? firstTab(counts) : "approved"));
    setCompare(Boolean(intent?.compare));
  }
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const keyOf = (row: VendorRequestRow) => row.vendorDirectoryId ?? row.vendorUserId ?? row.key;
  const vendorOptions = useMemo(
    () => [...new Map(requests.map((r) => [r.vendorDirectoryId ?? r.vendorUserId ?? r.key, r.vendorName])).entries()].map(([value, label]) => ({ value, label })),
    [requests],
  );
  const inTab = useMemo(() => requests.filter((row) => vendorAnswerGroup(row.state) === tab), [requests, tab]);
  const shown = useMemo(
    () => inTab.filter((row) => (!vendorFilter || keyOf(row) === vendorFilter) && matchesPortalListSearch(search, row.vendorName, row.note ?? "")),
    [inTab, vendorFilter, search],
  );
  const lowestKeys = useMemo(() => new Set(compareBids(requests).filter((b) => b.lowest).map((b) => b.key)), [requests]);
  const bidCount = counts.bids;
  const comparing = tab === "bids" && compare && bidCount > 1;

  return (
    <RecordListBand
      dataAttr="service-vendor-cycle"
      ariaLabel="Vendor answers"
      tabs={VENDOR_ANSWER_TABS.map(({ id, label }) => ({ id, label, count: counts[id] }))}
      activeId={tab}
      onChange={(id) => setTab(id as VendorAnswerGroup)}
      search={{ value: search, onChange: setSearch, placeholder: "Search vendors" }}
      actions={
        <>
          {tab === "bids" && bidCount > 1 ? (
            <PortalIconAction
              icon={Scale}
              label="Compare"
              active={compare}
              data-attr="service-compare-toggle"
              onClick={() => setCompare((on) => !on)}
            />
          ) : null}
          <RecordBandFilter
            dataAttr="service-vendor-cycle"
            fields={vendorOptions.length > 0 ? [{ id: "vendor", label: "Vendor", anyLabel: "Any vendor", value: vendorFilter, options: vendorOptions, onChange: setVendorFilter }] : []}
          />
        </>
      }
      plus={{ label: "Add vendors", onClick: onRequestBids, dataAttr: "service-request-more-vendors" }}
      isEmpty={comparing ? false : shown.length === 0}
      emptyTitle={search.trim() || vendorFilter ? "No vendors match" : requests.length === 0 ? emptyTitle : EMPTY_TITLE[tab]}
      middle={lead}
    >
      {comparing ? (
        <CompareCards rows={requests.filter((row) => row.state === "bid")} approvingBidId={approvingBidId} onApprove={onApprove} />
      ) : (
        shown.map((row) => {
          const total = row.bidTotalCents;
          const group = vendorAnswerGroup(row.state);
          const figure = total != null ? formatServiceMoney(total) : row.estimateCents != null ? formatServiceMoney(row.estimateCents) : undefined;
          const figureLabel = total != null ? "bid" : row.estimateCents != null ? "estimate" : undefined;
          const approving = approvingBidId === row.bidId;
          const FactIcon = row.state === "visit_booked" || row.state === "visit_done" ? CalendarDays : FACT_ICON[group];
          return (
            <PortalApplicantRecordRow
              key={row.key}
              name={`${row.vendorName}${group === "bids" && lowestKeys.has(row.key) && bidCount > 1 ? " · Lowest" : ""}`}
              tileLabel={row.vendorName}
              facts={<PortalRowFact icon={FactIcon}>{vendorRequestFact(row)}</PortalRowFact>}
              amount={figure}
              amountSubLabel={figureLabel}
              dataAttr="service-vendor-request-row"
              actions={
                <div className="flex items-center gap-1">
                  {group === "bids" ? (
                    <Button
                      type="button"
                      variant="primary"
                      data-attr="service-approve-bid"
                      className="h-7 rounded-full px-3 text-xs"
                      disabled={!row.canApprove || approving}
                      aria-label={`Approve bid from ${row.vendorName}`}
                      onClick={() => onApprove(row)}
                    >
                      {approving ? "Approving…" : "Approve bid"}
                    </Button>
                  ) : null}
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
        })
      )}
    </RecordListBand>
  );
}

/**
 * Vendors for an add-on service request. It has no vendors (they cannot take add-ons), so the band
 * uses the same four stage words and the one row under the current tab is whoever is handling it.
 */
export function AddOnCycleSection({
  currentStage,
  assignee,
  onOpenAssign,
}: {
  currentStage: ServiceStage;
  assignee: { name: string } | null;
  onOpenAssign: () => void;
}) {
  const [tab, setTab] = useState<ServiceStage>(currentStage);
  const [prevCurrent, setPrevCurrent] = useState(currentStage);
  if (currentStage !== prevCurrent) {
    setPrevCurrent(currentStage);
    setTab(currentStage);
  }
  const [search, setSearch] = useState("");
  const here = (id: ServiceStage) => Boolean(assignee) && id === currentStage && currentStage !== "open";
  const rowsHere = here(tab) && assignee ? [assignee] : [];
  const shown = rowsHere.filter((a) => matchesPortalListSearch(search, a.name));
  return (
    <RecordListBand
      dataAttr="service-vendor-cycle"
      ariaLabel="Service stage"
      tabs={SERVICE_STAGE_TABS.map((t) => ({ ...t, count: here(t.id) ? 1 : 0 }))}
      activeId={tab}
      onChange={(id) => setTab(id as ServiceStage)}
      search={{ value: search, onChange: setSearch, placeholder: "Search team" }}
      plus={{ label: "Add assignee", onClick: onOpenAssign, dataAttr: "service-assign-open" }}
      isEmpty={shown.length === 0}
      emptyTitle={search.trim() ? "No team members match" : assignee ? `Nobody in ${SERVICE_STAGE_LABEL[tab].toLowerCase()}` : "Nobody assigned yet"}
    >
      {shown.map((a) => (
        <PortalApplicantRecordRow
          key={a.name}
          name={a.name}
          tileIcon={UserRound}
          facts={<PortalRowFact icon={Clock}>{SERVICE_STAGE_LABEL[currentStage]}</PortalRowFact>}
          dataAttr="service-vendor-request-row"
        />
      ))}
    </RecordListBand>
  );
}
