"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, Clock, Receipt, Scale, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordBandFilter, RecordListBand } from "@/components/portal/record-list-band";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { MARKETPLACE_RADIUS_OPTIONS } from "@/components/portal/service-assign-dialog";
import { formatServiceMoney } from "@/lib/manager-service-workflow";
import { ADD_ON_NEXT_STEP_LABEL } from "@/lib/service-header-next-step";
import { formatServiceWhen, vendorRequestFact } from "@/lib/service-lifecycle";
import {
  PIPELINE_PRIVACY_LINE,
  PIPELINE_TABS,
  PIPELINE_TAB_LABEL,
  defaultPipelineTab,
  pipelineJobFact,
  sendBarState,
  type PipelineCandidate,
  type PipelineJobRow,
  type PipelineTabId,
  type ServicePipeline,
} from "@/lib/service-pipeline";
import { compareBids, type VendorRequestRow } from "@/lib/work-order-bid-cycle";
import type { PublishMarketplaceOptions } from "@/lib/work-order-vendor-offers";

/** Open the Vendors section on a given tab, optionally in the side-by-side compare view (the header's Compare bids). */
export type VendorsIntent = { tab?: PipelineTabId; compare?: boolean; nonce: number };

const EMPTY_TITLE: Record<PipelineTabId, string> = {
  available: "No vendors to send this job to",
  sent: "Nothing sent yet",
  bids: "No bids yet",
  scheduled: "Nobody scheduled yet",
  done: "Nothing done yet",
};

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

/** What a Bids row says: the bid, with the vendor's earlier estimate beside it when they gave one. */
function bidFact(row: VendorRequestRow): string {
  const estimate = row.estimateCents != null ? `Estimate ${formatServiceMoney(row.estimateCents)}` : "";
  return [vendorRequestFact(row), estimate].filter(Boolean).join(" · ");
}

/**
 * The Vendors section of a service - the job's whole vendor workflow, in order, for BOTH models
 * (maintenance and an add-on's linked vendor job): Available (tick vendors, "Send job to N") - Sent
 * (waiting; Withdraw) - Bids (price and time; Approve) - Scheduled (visit time; Reschedule, Mark done) -
 * Done (amount; Pay). One band with counts; rows are a vendor tile, the name, the trade and plain glyph
 * facts - never a badge. Approve exists only on a Bids row (an estimate is a fact on a row, never a thing to
 * approve) and the host performs every write.
 */
export function ServiceVendorPipeline({
  pipeline,
  trade,
  intent,
  sending,
  approvingBidId,
  allowMarketplace = true,
  onSend,
  onWithdraw,
  onApprove,
  onSchedule,
  onMarkDone,
  onPay,
  onMessage,
  lead,
}: {
  pipeline: ServicePipeline;
  /** The job's trade, sent with the marketplace reach. */
  trade: string;
  intent?: VendorsIntent | null;
  sending: boolean;
  approvingBidId: string | null;
  /** False where the PropLane marketplace cannot be reached (the demo). */
  allowMarketplace?: boolean;
  onSend: (vendorIds: string[], marketplace: PublishMarketplaceOptions | undefined) => void | Promise<void>;
  onWithdraw: (row: VendorRequestRow) => void;
  onApprove: (row: VendorRequestRow) => void;
  onSchedule: (row: PipelineJobRow) => void;
  onMarkDone: (row: PipelineJobRow) => void;
  onPay: (row: PipelineJobRow) => void;
  onMessage: (vendorName: string) => void;
  /** Cards between the band and the rows (the hired vendor's contact card, PropLane's suggestion). */
  lead?: ReactNode;
}) {
  const { counts } = pipeline;
  const startTab = defaultPipelineTab(counts);
  const [tab, setTab] = useState<PipelineTabId>(() => intent?.tab ?? startTab);
  const [compare, setCompare] = useState(Boolean(intent?.compare));
  // The view follows the job: an approved bid moves it to Scheduled, a send to Sent. A header intent wins.
  const [seen, setSeen] = useState({ startTab, nonce: intent?.nonce ?? 0 });
  if (seen.startTab !== startTab || seen.nonce !== (intent?.nonce ?? 0)) {
    setSeen({ startTab, nonce: intent?.nonce ?? 0 });
    setTab(intent && intent.nonce !== seen.nonce && intent.tab ? intent.tab : startTab);
    setCompare(Boolean(intent?.compare && intent.nonce !== seen.nonce));
  }
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [marketplace, setMarketplace] = useState(false);
  const [radiusMi, setRadiusMi] = useState<number>(5);

  const nameOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of pipeline.sent) names.set(row.vendorName, row.vendorName);
    for (const row of pipeline.bids) names.set(row.vendorName, row.vendorName);
    for (const row of pipeline.scheduled) names.set(row.vendorName, row.vendorName);
    for (const row of pipeline.done) names.set(row.vendorName, row.vendorName);
    for (const row of pipeline.available) names.set(row.name, row.name);
    return [...names.keys()].map((value) => ({ value, label: value }));
  }, [pipeline]);
  const keep = (name: string, extra = "") => (!vendorFilter || name === vendorFilter) && matchesPortalListSearch(search, name, extra);

  const available = pipeline.available.filter((row) => keep(row.name, row.trade));
  const sent = pipeline.sent.filter((row) => keep(row.vendorName, row.note ?? ""));
  const bids = pipeline.bids.filter((row) => keep(row.vendorName, row.note ?? ""));
  const scheduled = pipeline.scheduled.filter((row) => keep(row.vendorName));
  const done = pipeline.done.filter((row) => keep(row.vendorName));
  const shownCount = { available: available.length, sent: sent.length, bids: bids.length, scheduled: scheduled.length, done: done.length }[tab];
  const comparing = tab === "bids" && compare && pipeline.bids.length > 1;
  const lowestKeys = useMemo(() => new Set(compareBids(pipeline.bids).filter((b) => b.lowest).map((b) => b.key)), [pipeline.bids]);

  const bar = sendBarState(picked.length, marketplace && allowMarketplace);
  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const send = async () => {
    const ids = picked.slice(0, bar.count);
    await onSend(ids, marketplace && allowMarketplace ? { enabled: true, trade, radiusMi } : undefined);
    setPicked([]);
    setMarketplace(false);
  };

  const availableRow = (candidate: PipelineCandidate) => (
    <PortalApplicantRecordRow
      key={candidate.id}
      name={candidate.name}
      address={candidate.trade || undefined}
      facts={candidate.matchesTrade ? undefined : <PortalRowFact icon={Wrench}>Other trade</PortalRowFact>}
      checked={picked.includes(candidate.id)}
      onSelectedChange={() => toggle(candidate.id)}
      selectLabel={candidate.name}
      dataAttr="service-pipeline-available-row"
    />
  );

  const requestRow = (row: VendorRequestRow, group: "sent" | "bids") => {
    const total = row.bidTotalCents;
    const approving = approvingBidId === row.bidId;
    const declined = row.state === "declined";
    return (
      <PortalApplicantRecordRow
        key={row.key}
        name={`${row.vendorName}${group === "bids" && lowestKeys.has(row.key) && pipeline.bids.length > 1 ? " · Lowest" : ""}`}
        tileLabel={row.vendorName}
        facts={
          <PortalRowFact icon={row.state === "visit_booked" || row.state === "visit_done" ? CalendarDays : group === "bids" ? Receipt : Clock}>
            {group === "bids" ? bidFact(row) : vendorRequestFact(row)}
          </PortalRowFact>
        }
        amount={group === "bids" && total != null ? formatServiceMoney(total) : undefined}
        amountSubLabel={group === "bids" && total != null ? "bid" : undefined}
        dataAttr={group === "bids" ? "service-pipeline-bid-row" : "service-pipeline-sent-row"}
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
            ) : declined ? null : (
              <Button
                type="button"
                variant="outline"
                data-attr="service-withdraw-request"
                className="h-7 rounded-full px-3 text-xs"
                aria-label={`Withdraw from ${row.vendorName}`}
                onClick={() => onWithdraw(row)}
              >
                Withdraw
              </Button>
            )}
            <RowActionsMenu
              label={row.vendorName}
              items={[{ id: "message", label: "Message", onSelect: () => onMessage(row.vendorName), dataAttr: "service-vendor-request-message" }]}
            />
          </div>
        }
      />
    );
  };

  const jobRow = (row: PipelineJobRow, group: "scheduled" | "done") => (
    <PortalApplicantRecordRow
      key={row.key}
      name={row.vendorName}
      facts={<PortalRowFact icon={CalendarDays}>{pipelineJobFact(row, formatServiceWhen)}</PortalRowFact>}
      amount={row.amountCents != null ? formatServiceMoney(row.amountCents) : undefined}
      dataAttr={group === "scheduled" ? "service-pipeline-scheduled-row" : "service-pipeline-done-row"}
      actions={
        <div className="flex items-center gap-1">
          {group === "scheduled" ? (
            <>
              <Button
                type="button"
                variant="outline"
                data-attr="service-reschedule"
                className="h-7 rounded-full px-3 text-xs"
                aria-label={row.visitAt ? `Reschedule ${row.vendorName}` : `Schedule ${row.vendorName}`}
                onClick={() => onSchedule(row)}
              >
                {row.visitAt ? "Reschedule" : "Schedule"}
              </Button>
              <Button
                type="button"
                variant="primary"
                data-attr="service-mark-done"
                className="h-7 rounded-full px-3 text-xs"
                aria-label={`Mark ${row.vendorName}'s job done`}
                onClick={() => onMarkDone(row)}
              >
                {ADD_ON_NEXT_STEP_LABEL["mark-done"]}
              </Button>
            </>
          ) : row.canPay ? (
            <Button
              type="button"
              variant="primary"
              data-attr="service-pay-vendor"
              className="h-7 rounded-full px-3 text-xs"
              aria-label={`Pay ${row.vendorName}`}
              onClick={() => onPay(row)}
            >
              Pay
            </Button>
          ) : null}
          <RowActionsMenu
            label={row.vendorName}
            items={[{ id: "message", label: "Message", onSelect: () => onMessage(row.vendorName), dataAttr: "service-vendor-request-message" }]}
          />
        </div>
      }
    />
  );

  return (
    <div data-attr="service-vendor-pipeline">
      <RecordListBand
        dataAttr="service-vendor-cycle"
        ariaLabel="Vendors"
        tabs={PIPELINE_TABS.map((id) => ({ id, label: PIPELINE_TAB_LABEL[id], count: counts[id] }))}
        activeId={tab}
        onChange={(id) => setTab(id as PipelineTabId)}
        search={{ value: search, onChange: setSearch, placeholder: "Search vendors" }}
        actions={
          <>
            {tab === "bids" && pipeline.bids.length > 1 ? (
              <PortalIconAction icon={Scale} label="Compare" active={compare} data-attr="service-compare-toggle" onClick={() => setCompare((on) => !on)} />
            ) : null}
            <RecordBandFilter
              dataAttr="service-vendor-cycle"
              fields={nameOptions.length > 1 ? [{ id: "vendor", label: "Vendor", anyLabel: "Any vendor", value: vendorFilter, options: nameOptions, onChange: setVendorFilter }] : []}
            />
          </>
        }
        isEmpty={comparing ? false : shownCount === 0}
        emptyTitle={search.trim() || vendorFilter ? "No vendors match" : EMPTY_TITLE[tab]}
        middle={lead}
      >
        {comparing ? (
          <CompareCards rows={pipeline.bids} approvingBidId={approvingBidId} onApprove={onApprove} />
        ) : tab === "available" ? (
          available.map(availableRow)
        ) : tab === "sent" ? (
          sent.map((row) => requestRow(row, "sent"))
        ) : tab === "bids" ? (
          bids.map((row) => requestRow(row, "bids"))
        ) : tab === "scheduled" ? (
          scheduled.map((row) => jobRow(row, "scheduled"))
        ) : (
          done.map((row) => jobRow(row, "done"))
        )}
      </RecordListBand>
      {tab === "available" ? (
        <div
          className="sticky bottom-0 z-10 mt-2 border-t border-border bg-card/95 px-3 py-3 backdrop-blur sm:px-4"
          data-attr="service-send-bar"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {allowMarketplace ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={marketplace}
                    disabled={sending}
                    onChange={(e) => setMarketplace(e.target.checked)}
                    data-attr="service-send-marketplace"
                  />
                  <span>Also send to PropLane vendors within</span>
                </label>
                <FieldSingleSelect
                  label="Marketplace radius"
                  hideLabel
                  variant="pill"
                  value={String(radiusMi)}
                  options={MARKETPLACE_RADIUS_OPTIONS.map((mi) => ({ value: String(mi), label: `${mi} mi` }))}
                  onChange={(next) => setRadiusMi(Number(next))}
                  disabled={sending || !marketplace}
                  dataAttr="service-send-marketplace-radius"
                />
              </div>
            ) : null}
            <Button
              type="button"
              variant="primary"
              className="ml-auto h-9 rounded-full px-5 text-sm"
              data-attr="service-send-job"
              disabled={bar.disabled || sending}
              onClick={() => void send()}
            >
              {sending ? "Sending…" : bar.label}
            </Button>
          </div>
          <p className="mt-2 text-[12.5px] text-muted" data-attr="service-send-privacy">
            {PIPELINE_PRIVACY_LINE}
            {bar.capped ? " Up to 10 vendors per send." : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}
