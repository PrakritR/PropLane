"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, Clock, Hourglass, Link2, MapPin, Receipt, Scale, Star, Store, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordBandFilter, RecordListBand } from "@/components/portal/record-list-band";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RowActionsMenu, type RowAction } from "@/components/portal/row-actions-menu";
import { ServiceSendJobPopup } from "@/components/portal/service-send-job-popup";
import { formatServiceMoney } from "@/lib/manager-service-workflow";
import { ADD_ON_NEXT_STEP_LABEL } from "@/lib/service-header-next-step";
import { formatServiceWhen, vendorRequestFact } from "@/lib/service-lifecycle";
import {
  PIPELINE_TABS,
  PIPELINE_TAB_LABEL,
  VENDOR_ORIGIN_FACT,
  defaultPipelineTab,
  pipelineJobFact,
  type PipelineCandidate,
  type PipelineJobRow,
  type PipelineRequestRow,
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
 * (maintenance and an add-on's linked vendor job): Available - Sent - Bids - Scheduled - Done. One band
 * with counts; every row is the same row the Vendors list draws (tile, name, trade, plain glyph facts, ⋯) -
 * never a badge, a checkbox or a bar of its own. What a row can do lives in its ⋯: Send job (Available),
 * Withdraw (Sent), Approve bid (a Bids row with a submitted bid), Reschedule / Mark done (Scheduled), Pay (Done),
 * and Open vendor on all of them. The band's round + opens the Send job popup. Approve exists only on a Bids row
 * (an estimate is a fact on a row, never a thing to approve) and the host performs every write.
 */
export function ServiceVendorPipeline({
  pipeline,
  trade,
  intent,
  sending,
  approvingBidId,
  paying = false,
  allowMarketplace = true,
  onSend,
  onWithdraw,
  onApprove,
  onSchedule,
  onMarkDone,
  onPay,
  onMessage,
  onOpenVendor,
  lead,
}: {
  pipeline: ServicePipeline;
  /** The job's trade, sent with the marketplace reach. */
  trade: string;
  intent?: VendorsIntent | null;
  sending: boolean;
  approvingBidId: string | null;
  /** A pay request is already in flight; a second tap would race its payment claim. */
  paying?: boolean;
  /** False where the PropLane marketplace cannot be reached (the demo). */
  allowMarketplace?: boolean;
  onSend: (vendorIds: string[], marketplace: PublishMarketplaceOptions | undefined) => void | Promise<void>;
  onWithdraw: (row: VendorRequestRow) => void;
  onApprove: (row: VendorRequestRow) => void;
  onSchedule: (row: PipelineJobRow) => void;
  onMarkDone: (row: PipelineJobRow) => void;
  onPay: (row: PipelineJobRow) => void;
  onMessage?: (vendorName: string) => void;
  /** Open a vendor's record; a vendor with no roster id (a marketplace vendor) has no record to open. */
  onOpenVendor?: (vendorDirectoryId: string, vendorName: string) => void;
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
  const [sendOpen, setSendOpen] = useState(false);
  const [sendSeed, setSendSeed] = useState<string[]>([]);

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

  const openSend = (seed: string[] = []) => {
    setSendSeed(seed);
    setSendOpen(true);
  };
  const openVendorItem = (vendorDirectoryId: string | null | undefined, name: string): RowAction | null =>
    onOpenVendor && vendorDirectoryId
      ? { id: "open-vendor", label: "Open vendor", onSelect: () => onOpenVendor(vendorDirectoryId, name), dataAttr: "service-pipeline-open-vendor" }
      : null;
  const messageItem = (name: string): RowAction | null =>
    onMessage ? { id: "message", label: "Message", onSelect: () => onMessage(name), dataAttr: "service-vendor-request-message" } : null;

  const availableRow = (candidate: PipelineCandidate) => (
    <PortalApplicantRecordRow
      key={candidate.id}
      name={candidate.name}
      address={candidate.trade || undefined}
      facts={
        <>
          {candidate.rating && candidate.rating.count > 0 ? (
            <PortalRowFact icon={Star} srLabel="Review rating">{`${candidate.rating.average.toFixed(1)} (${candidate.rating.count})`}</PortalRowFact>
          ) : null}
          {candidate.city ? <PortalRowFact icon={MapPin} srLabel="Area">{candidate.city}</PortalRowFact> : null}
          {candidate.matchesTrade ? null : <PortalRowFact icon={Wrench}>Other trade</PortalRowFact>}
        </>
      }
      dataAttr="service-pipeline-available-row"
      actions={
        <RowActionsMenu
          label={candidate.name}
          items={[
            { id: "send-job", label: "Send job", onSelect: () => openSend([candidate.id]), dataAttr: "service-pipeline-send-job" },
            openVendorItem(candidate.id, candidate.name),
          ]}
        />
      }
    />
  );

  const requestRow = (row: PipelineRequestRow, group: "sent" | "bids") => {
    const total = row.bidTotalCents;
    const approving = approvingBidId === row.bidId;
    const declined = row.state === "declined";
    return (
      <PortalApplicantRecordRow
        key={row.key}
        name={`${row.vendorName}${group === "bids" && lowestKeys.has(row.key) && pipeline.bids.length > 1 ? " · Lowest" : ""}`}
        tileLabel={row.vendorName}
        facts={
          <>
            <PortalRowFact icon={row.state === "visit_booked" || row.state === "visit_done" ? CalendarDays : group === "bids" ? Receipt : Clock}>
              {group === "bids" ? bidFact(row) : vendorRequestFact(row)}
            </PortalRowFact>
            {row.originFact ? (
              <PortalRowFact icon={row.originFact === VENDOR_ORIGIN_FACT.service_link ? Link2 : Store}>{row.originFact}</PortalRowFact>
            ) : null}
            {row.contactFact ? <PortalRowFact icon={Hourglass}>{row.contactFact}</PortalRowFact> : null}
          </>
        }
        amount={group === "bids" && total != null ? formatServiceMoney(total) : undefined}
        amountSubLabel={group === "bids" && total != null ? "bid" : undefined}
        dataAttr={group === "bids" ? "service-pipeline-bid-row" : "service-pipeline-sent-row"}
        actions={
          <RowActionsMenu
            label={row.vendorName}
            items={[
              group === "bids"
                ? { id: "approve-bid", label: approving ? "Approving…" : "Approve bid", onSelect: () => onApprove(row), disabled: !row.canApprove || approving, dataAttr: "service-approve-bid" }
                : declined
                  ? null
                  : { id: "withdraw", label: "Withdraw", onSelect: () => onWithdraw(row), dataAttr: "service-withdraw-request" },
              openVendorItem(row.vendorDirectoryId, row.vendorName),
              messageItem(row.vendorName),
            ]}
          />
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
        <RowActionsMenu
          label={row.vendorName}
          items={[
            group === "scheduled"
              ? { id: "reschedule", label: row.visitAt ? "Reschedule" : "Schedule", onSelect: () => onSchedule(row), dataAttr: "service-reschedule" }
              : row.canPay
                ? { id: "pay", label: paying ? "Paying…" : "Pay", onSelect: () => onPay(row), disabled: paying, dataAttr: "service-pay-vendor" }
                : null,
            group === "scheduled" || row.vendorSaysDone
              ? { id: "mark-done", label: ADD_ON_NEXT_STEP_LABEL["mark-done"], onSelect: () => onMarkDone(row), dataAttr: "service-mark-done" }
              : null,
            openVendorItem(row.vendorDirectoryId, row.vendorName),
            messageItem(row.vendorName),
          ]}
        />
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
        plus={{ label: "Add bid request", dataAttr: "service-send-plus", onClick: () => openSend() }}
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
      <ServiceSendJobPopup
        open={sendOpen}
        candidates={pipeline.available}
        trade={trade}
        sending={sending}
        allowMarketplace={allowMarketplace}
        initialVendorIds={sendSeed}
        onClose={() => setSendOpen(false)}
        onSend={onSend}
      />
    </div>
  );
}
