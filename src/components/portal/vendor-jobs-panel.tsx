"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  readVendorWorkOrderRows,
  syncManagerWorkOrdersFromServer,
  MANAGER_WORK_ORDERS_EVENT,
} from "@/lib/manager-work-orders-storage";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { parseMoneyAmount } from "@/lib/household-charges";
import { fetchWorkOrderBidsResult, type WorkOrderBid } from "@/lib/work-order-bids";
import { upsertWorkOrderBid, WORK_ORDER_BIDS_EVENT } from "@/lib/work-order-bids-storage";
import { fetchOpenJobListings, formatBudgetRange, type OpenJobListing } from "@/lib/work-order-open-listings";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";
import {
  VENDOR_JOBS_LIST_TABS,
  VENDOR_JOBS_LIST_TAB_LABELS,
  vendorJobsListHref,
  type VendorJobsListTabId,
} from "@/lib/portal-detail-routes";
import { useAppUi } from "@/components/providers/app-ui-provider";

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toDatetimeLocalValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromDatetimeLocalValue(s: string): string | null {
  if (!s.trim()) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * A job is "invited" once its manager has opened it for this vendor's bid
 * (today's single-vendor-at-a-time `biddingOpen` flag — docs/agents/vendor-portal.md
 * Phase 2) and stays invited while a bid is still just `submitted` (not yet
 * accepted/declined by the manager). Purely additive to Services, which keeps
 * classifying the same rows into Potential/Current/Past unchanged.
 */
export function isInvitedJob(row: DemoManagerWorkOrderRow, bid: WorkOrderBid | undefined): boolean {
  return Boolean(row.biddingOpen) && (!bid || bid.status === "submitted");
}

type BidFormState = { amount: string; earliest: string; note: string };

function defaultBidForm(bid: WorkOrderBid | undefined): BidFormState {
  return {
    amount: bid?.amountCents ? (bid.amountCents / 100).toFixed(2) : "",
    earliest: bid?.proposedTime ? toDatetimeLocalValue(bid.proposedTime) : "",
    note: bid?.note ?? "",
  };
}

/** Bid modal target — shared shape for an Invited row (a full work order) and an
 * Open listing (a redacted marketplace row); both key their bid on `workOrderId`. */
type BidTarget = { workOrderId: string; title: string; subtitle: string };

const OPEN_LISTINGS_PAGE_SIZE = 20;

/**
 * Vendor Jobs board (C152/C153). Invited lists jobs a manager has opened for
 * this vendor's bid specifically; Open is the cross-workspace marketplace —
 * every manager's `work_order_open_listings` row currently `status: "open"`,
 * paginated and filterable by trade/area (`work-order-open-listings.server.ts`).
 * Submit bid / Withdraw on both tabs post to the SAME `/api/portal/work-order-bids`
 * route Services already uses; `resolveVendorWorkOrderAccess` admits any vendor
 * once an open listing exists. Services' own Potential/Current/Past classification
 * (`vendor-work-order-tabs.ts`) is unchanged; Jobs is a second, additive view.
 */
export function VendorJobsPanel({ tabId = "invited" }: { tabId?: VendorJobsListTabId }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [rows, setRows] = useState<DemoManagerWorkOrderRow[]>(() => readVendorWorkOrderRows());
  const [bidsByWorkOrderId, setBidsByWorkOrderId] = useState<Record<string, WorkOrderBid>>({});
  const [bidsSyncFailed, setBidsSyncFailed] = useState(false);
  const [bidTarget, setBidTarget] = useState<BidTarget | null>(null);
  const [form, setForm] = useState<BidFormState>({ amount: "", earliest: "", note: "" });
  const [submitting, setSubmitting] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  // ---- Open marketplace browse state ----
  const [listings, setListings] = useState<OpenJobListing[]>([]);
  const [listingsLoading, setListingsLoading] = useState(false);
  const [listingsFailed, setListingsFailed] = useState(false);
  const [listingsHasMore, setListingsHasMore] = useState(false);
  const [tradeFilter, setTradeFilter] = useState("");
  const [areaFilter, setAreaFilter] = useState("");
  const [areaFilterDraft, setAreaFilterDraft] = useState("");

  const loadBids = useCallback(async () => {
    const result = await fetchWorkOrderBidsResult();
    setBidsSyncFailed(!result.ok);
    if (!result.ok) return;
    setBidsByWorkOrderId(Object.fromEntries(result.bids.map((b) => [b.workOrderId, b])));
  }, []);

  useEffect(() => {
    const sync = () => setRows(readVendorWorkOrderRows());
    const onBidsChanged = () => void loadBids();
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    window.addEventListener(WORK_ORDER_BIDS_EVENT, onBidsChanged);
    void syncManagerWorkOrdersFromServer().then(() => sync());
    void loadBids();
    return () => {
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
      window.removeEventListener(WORK_ORDER_BIDS_EVENT, onBidsChanged);
    };
  }, [loadBids]);

  const loadListings = useCallback(
    async (offset: number, opts: { append: boolean }) => {
      // /demo never has a real signed-in session to browse against; keep the
      // tab's empty state rather than surfacing a 401 as a sync error.
      if (demo) {
        setListings([]);
        setListingsHasMore(false);
        return;
      }
      setListingsLoading(true);
      const result = await fetchOpenJobListings({
        trade: tradeFilter || undefined,
        area: areaFilter || undefined,
        offset,
        limit: OPEN_LISTINGS_PAGE_SIZE,
      });
      setListingsFailed(!result.ok);
      if (result.ok) {
        setListings((prev) => (opts.append ? [...prev, ...result.listings] : result.listings));
        setListingsHasMore(result.hasMore);
      }
      setListingsLoading(false);
    },
    [demo, tradeFilter, areaFilter],
  );

  useEffect(() => {
    if (tabId !== "open") return;
    void loadListings(0, { append: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, tradeFilter, areaFilter, demo]);

  const invited = useMemo(
    () => rows.filter((row) => isInvitedJob(row, bidsByWorkOrderId[row.id])),
    [rows, bidsByWorkOrderId],
  );

  const tabs = useMemo(
    () =>
      VENDOR_JOBS_LIST_TABS.map((id) => ({
        id,
        label: VENDOR_JOBS_LIST_TAB_LABELS[id],
        count: id === "invited" ? invited.length : listings.length,
        href: vendorJobsListHref("/vendor", id),
        dataAttr: `vendor-jobs-tab-${id}`,
      })),
    [invited.length, listings.length],
  );

  const bidTargetBid = bidTarget ? bidsByWorkOrderId[bidTarget.workOrderId] : undefined;

  const openBidForm = (target: BidTarget) => {
    setForm(defaultBidForm(bidsByWorkOrderId[target.workOrderId]));
    setBidTarget(target);
  };

  const closeBidForm = () => setBidTarget(null);

  const submitBid = async () => {
    if (!bidTarget) return;
    const amountCents = Math.round(parseMoneyAmount(form.amount) * 100);
    const proposedTimeIso = fromDatetimeLocalValue(form.earliest);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      showToast("Enter a valid bid amount.");
      return;
    }
    if (!proposedTimeIso) {
      showToast("Choose the earliest date you can start.");
      return;
    }
    setSubmitting(true);
    try {
      if (demo) {
        upsertWorkOrderBid({
          workOrderId: bidTarget.workOrderId,
          vendorUserId: "demo-vendor-1",
          vendorDirectoryId: "demo-vendor-1",
          quoteMode: "upfront",
          amountCents,
          materialsCents: bidTargetBid?.materialsCents ?? 0,
          proposedTime: proposedTimeIso,
          note: form.note.trim() || null,
          status: "submitted",
        });
        await loadBids();
        showToast("Bid submitted.");
        closeBidForm();
        return;
      }
      const res = await fetch("/api/portal/work-order-bids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "submit",
          workOrderId: bidTarget.workOrderId,
          amountCents,
          materialsCents: bidTargetBid?.materialsCents ?? 0,
          proposedTime: proposedTimeIso,
          note: form.note,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not submit bid.");
      await loadBids();
      showToast("Bid submitted.");
      closeBidForm();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not submit bid.");
    } finally {
      setSubmitting(false);
    }
  };

  const withdrawBid = async () => {
    if (!bidTarget) return;
    setWithdrawing(true);
    try {
      if (demo) {
        setBidsByWorkOrderId((prev) => {
          const next = { ...prev };
          delete next[bidTarget.workOrderId];
          return next;
        });
        showToast("Bid withdrawn.");
        closeBidForm();
        return;
      }
      const res = await fetch("/api/portal/work-order-bids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "withdraw", workOrderId: bidTarget.workOrderId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not withdraw bid.");
      await loadBids();
      showToast("Bid withdrawn.");
      closeBidForm();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not withdraw bid.");
    } finally {
      setWithdrawing(false);
    }
  };

  const destinations = tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: tab.href,
    count: tab.count,
    dataAttr: tab.dataAttr,
  }));

  const bidModal = (
    <Modal
      open={Boolean(bidTarget)}
      title="Submit a bid"
      onClose={closeBidForm}
      dataAttr="vendor-jobs-submit-bid"
      footer={
        <ModalFooter>
          {bidTargetBid && bidTargetBid.status === "submitted" ? (
            <Button
              type="button"
              variant="outline"
              data-attr="vendor-jobs-withdraw-bid"
              disabled={withdrawing || submitting}
              onClick={() => void withdrawBid()}
            >
              {withdrawing ? "Withdrawing…" : "Withdraw bid"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            data-attr="vendor-jobs-submit-bid-save"
            disabled={submitting || withdrawing}
            onClick={() => void submitBid()}
          >
            {submitting ? "Submitting…" : bidTargetBid ? "Update bid" : "Submit bid"}
          </Button>
        </ModalFooter>
      }
    >
      {bidTarget ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{[bidTarget.title, bidTarget.subtitle].filter(Boolean).join(" · ")}</p>
          <div>
            <p className="text-sm font-medium text-foreground">Your price</p>
            <Input
              inputMode="decimal"
              placeholder="150.00"
              value={form.amount}
              onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
              className="mt-1"
              data-attr="vendor-jobs-bid-amount"
            />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Earliest available</p>
            <Input
              type="datetime-local"
              value={form.earliest}
              onChange={(e) => setForm((prev) => ({ ...prev, earliest: e.target.value }))}
              className="mt-1"
              data-attr="vendor-jobs-bid-earliest"
            />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Note</p>
            <Textarea
              placeholder="What's included, availability, etc."
              value={form.note}
              onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))}
              className="mt-1"
              data-attr="vendor-jobs-bid-note"
            />
          </div>
        </div>
      ) : null}
    </Modal>
  );

  if (tabId === "open") {
    return (
      <ManagerPortalPageShell title="Jobs" hideTitleOnMobileNav titleInlineFilter={null} compactFilterRow>
        <PortalListControlStack
          className="mb-2 max-lg:mb-1.5"
          variant="command"
          destinations={destinations}
          activeDestinationId="open"
          destinationAriaLabel="Jobs"
        />
        <div className="mb-3 flex flex-wrap items-center gap-2" data-attr="vendor-jobs-open-filters">
          <Select
            aria-label="Filter by trade"
            data-attr="vendor-jobs-open-trade-filter"
            className="h-9 w-auto min-w-[9rem] rounded-lg text-xs"
            value={tradeFilter}
            onChange={(e) => setTradeFilter(e.target.value)}
          >
            <option value="">All trades</option>
            {VENDOR_TRADE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Filter by area"
            placeholder="City or area"
            className="h-9 w-40 rounded-lg text-xs"
            data-attr="vendor-jobs-open-area-filter"
            value={areaFilterDraft}
            onChange={(e) => setAreaFilterDraft(e.target.value)}
            onBlur={() => setAreaFilter(areaFilterDraft.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter") setAreaFilter(areaFilterDraft.trim());
            }}
          />
        </div>
        {listingsFailed ? (
          <p className="mb-4 rounded-xl border px-4 py-3 text-sm portal-banner-danger" data-attr="vendor-jobs-open-sync-error">
            Couldn&apos;t load open jobs right now. Retrying automatically.
          </p>
        ) : null}
        <PortalRecordListSurface
          isEmpty={listings.length === 0 && !listingsLoading}
          emptyCard={{
            title: "No open jobs right now",
            section: "tasks",
            sibling: null,
            actions: [],
          }}
          loading={listingsLoading && listings.length === 0}
          dataAttr="vendor-jobs-open-list"
        >
          {listings.map((listing) => {
            const bid = bidsByWorkOrderId[listing.workOrderId];
            const budget = formatBudgetRange(listing.budgetMinCents, listing.budgetMaxCents);
            return (
              <PortalServiceRecordRow
                key={listing.id}
                title={listing.description}
                subtitle={[listing.trade, listing.area, listing.timeframe, budget, bid ? "Bid submitted" : null]
                  .filter(Boolean)
                  .join(" · ")}
                onOpen={() =>
                  openBidForm({
                    workOrderId: listing.workOrderId,
                    title: listing.trade,
                    subtitle: [listing.area, listing.timeframe].filter(Boolean).join(" · "),
                  })
                }
                dataAttr="vendor-job-open-row"
              />
            );
          })}
        </PortalRecordListSurface>
        {listingsHasMore ? (
          <div className="mt-3 flex justify-center">
            <Button
              type="button"
              variant="outline"
              className="h-8 rounded-full px-4 text-xs"
              data-attr="vendor-jobs-open-load-more"
              disabled={listingsLoading}
              onClick={() => void loadListings(listings.length, { append: true })}
            >
              {listingsLoading ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
        {bidModal}
      </ManagerPortalPageShell>
    );
  }

  return (
    <ManagerPortalPageShell title="Jobs" hideTitleOnMobileNav titleInlineFilter={null} compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={destinations}
        activeDestinationId="invited"
        destinationAriaLabel="Jobs"
      />
      {bidsSyncFailed ? (
        <p className="mb-4 rounded-xl border px-4 py-3 text-sm portal-banner-danger" data-attr="vendor-jobs-sync-error">
          Couldn&apos;t refresh the latest bidding status. This may be out of date. Retrying automatically.
        </p>
      ) : null}
      <PortalRecordListSurface
        isEmpty={invited.length === 0}
        emptyCard={{
          title: "No invited jobs right now",
          section: "tasks",
          sibling: null,
          actions: [],
        }}
        dataAttr="vendor-jobs-invited-list"
      >
        {invited.map((row) => {
          const bid = bidsByWorkOrderId[row.id];
          return (
            <PortalServiceRecordRow
              key={row.id}
              title={row.title}
              subtitle={[row.reference, propertyLabel(row), bid ? "Bid submitted" : "Invited to bid"]
                .filter(Boolean)
                .join(" · ")}
              onOpen={() => openBidForm({ workOrderId: row.id, title: row.title, subtitle: propertyLabel(row) })}
              dataAttr="vendor-job-invited-row"
            />
          );
        })}
      </PortalRecordListSurface>
      {bidModal}
    </ManagerPortalPageShell>
  );
}
