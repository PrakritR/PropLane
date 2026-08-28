"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ManagerPortalPageShell,
  ManagerPortalStatusPills,
  MANAGER_TABLE_TH,
  PORTAL_TOOLBAR_GROUP,
  PORTAL_TOOLBAR_PILL_BUTTON,
  PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE,
} from "@/components/portal/portal-metrics";
import { PORTAL_DATA_TABLE, PortalDataTableColGroup, portalTableColumnPercents, PORTAL_DATA_TABLE_WRAP,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TR_EXPANDABLE,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_DETAIL_ROW,
  PORTAL_TABLE_DETAIL_CELL,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
  PortalTableInlineExpand,
  PortalDataTableEmpty,
  createPortalRowExpandClick,} from "@/components/portal/portal-data-table";
import { WorkOrderStatusBadge } from "@/components/portal/resident-services-panel";
import { readVendorWorkOrderRows, syncManagerWorkOrdersFromServer, MANAGER_WORK_ORDERS_EVENT, updateManagerWorkOrder } from "@/lib/manager-work-orders-storage";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { parseMoneyAmount } from "@/lib/household-charges";
import { fetchWorkOrderBidsResult, type WorkOrderBid } from "@/lib/work-order-bids";
import { fetchVendorPayoutsResult, type VendorPayout } from "@/lib/vendor-payouts";
import { upsertWorkOrderBid, WORK_ORDER_BIDS_EVENT } from "@/lib/work-order-bids-storage";
import {
  isPricingPendingBid,
  vendorWorkOrderPhaseLabel,
  vendorWorkOrderTab,
  VENDOR_WORK_ORDER_TAB_LABELS,
  VENDOR_WORK_ORDER_TAB_ORDER,
  type VendorWorkOrderTab,
} from "@/lib/vendor-work-order-tabs";
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

type BidDraft = { amount: string; materials: string; proposedTime: string; note: string };

function defaultBidDraft(row: DemoManagerWorkOrderRow, bid: WorkOrderBid | undefined): BidDraft {
  const laborCents = bid?.amountCents ?? row.vendorCostCents;
  const materialsCents = bid?.materialsCents ?? row.materialsCostCents;
  return {
    amount: laborCents ? (laborCents / 100).toFixed(2) : "",
    materials: materialsCents ? (materialsCents / 100).toFixed(2) : "",
    proposedTime: bid?.proposedTime ? toDatetimeLocalValue(bid.proposedTime) : "",
    note: bid?.note ?? "",
  };
}

function formatVisitLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Work orders offered/assigned to the signed-in vendor. Read-only except for submitting a
 * cost/time bid once the manager has opened a work order for bids. */
export function VendorWorkOrdersPanel() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [rows, setRows] = useState<DemoManagerWorkOrderRow[]>(() => readVendorWorkOrderRows());
  const [bidsByWorkOrderId, setBidsByWorkOrderId] = useState<Record<string, WorkOrderBid>>({});
  const [payoutsByWorkOrderId, setPayoutsByWorkOrderId] = useState<Record<string, VendorPayout>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftById, setDraftById] = useState<Record<string, BidDraft>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [savingPriceId, setSavingPriceId] = useState<string | null>(null);
  const [doneNoteById, setDoneNoteById] = useState<Record<string, string>>({});
  const [markingDoneId, setMarkingDoneId] = useState<string | null>(null);
  /** Chosen before a bid row exists — once scheduled/submitted, the row's own quoteMode wins. */
  const [modeById, setModeById] = useState<Record<string, "upfront" | "after_consultation">>({});
  const [consultationDraftById, setConsultationDraftById] = useState<Record<string, string>>({});
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const [tab, setTab] = useState<VendorWorkOrderTab>("quote");
  const [bidsSyncFailed, setBidsSyncFailed] = useState(false);
  const [payoutsSyncFailed, setPayoutsSyncFailed] = useState(false);

  const loadBids = useCallback(async () => {
    const result = await fetchWorkOrderBidsResult();
    setBidsSyncFailed(!result.ok);
    if (!result.ok) return;
    setBidsByWorkOrderId(Object.fromEntries(result.bids.map((b) => [b.workOrderId, b])));
  }, []);

  const loadPayouts = useCallback(async () => {
    const result = await fetchVendorPayoutsResult();
    setPayoutsSyncFailed(!result.ok);
    if (!result.ok) return;
    setPayoutsByWorkOrderId(Object.fromEntries(result.payouts.map((p) => [p.workOrderId, p])));
  }, []);

  useEffect(() => {
    const sync = () => setRows(readVendorWorkOrderRows());
    const onBidsChanged = () => void loadBids();
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    window.addEventListener(WORK_ORDER_BIDS_EVENT, onBidsChanged);
    void syncManagerWorkOrdersFromServer().then(() => sync());
    void loadBids();
    void loadPayouts();

    // Bidding state (open/accepted) and payout status can change server-side while this
    // tab sits idle (manager accepts another bid, a payout posts) — refresh on a short
    // poll and whenever the tab regains focus so they can't silently go stale.
    const refreshAll = () => {
      void syncManagerWorkOrdersFromServer({ force: true }).then(() => sync());
      void loadBids();
      void loadPayouts();
    };
    // Don't poll three endpoints for a hidden/background tab (egress on the free
    // plan); visibilitychange re-syncs the moment it comes back to the foreground.
    const id = window.setInterval(() => {
      if (!document.hidden) refreshAll();
    }, 60_000);
    const onVisible = () => {
      if (!document.hidden) refreshAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refreshAll);

    return () => {
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
      window.removeEventListener(WORK_ORDER_BIDS_EVENT, onBidsChanged);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refreshAll);
    };
  }, [loadBids, loadPayouts]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => (b.scheduledAtIso ?? "").localeCompare(a.scheduledAtIso ?? "")),
    [rows],
  );

  const tabCounts = useMemo(() => {
    const c: Record<VendorWorkOrderTab, number> = { quote: 0, tour: 0, scheduled: 0, completed: 0 };
    for (const row of sorted) c[vendorWorkOrderTab(row, bidsByWorkOrderId[row.id])] += 1;
    return c;
  }, [sorted, bidsByWorkOrderId]);

  const tabs = useMemo(
    () =>
      VENDOR_WORK_ORDER_TAB_ORDER.map((id) => ({
        id,
        label: VENDOR_WORK_ORDER_TAB_LABELS[id],
        count: tabCounts[id],
        dataAttr: `vendor-wo-tab-${id}`,
      })),
    [tabCounts],
  );

  const tabPickRef = useRef(false);
  useEffect(() => {
    if (tabPickRef.current || sorted.length === 0) return;
    const first = VENDOR_WORK_ORDER_TAB_ORDER.find((id) => tabCounts[id] > 0);
    if (first) setTab(first);
    tabPickRef.current = true;
  }, [sorted.length, tabCounts]);

  const visible = useMemo(
    () => sorted.filter((row) => vendorWorkOrderTab(row, bidsByWorkOrderId[row.id]) === tab),
    [sorted, tab, bidsByWorkOrderId],
  );

  const openExpand = (row: DemoManagerWorkOrderRow) => {
    setExpandedId(row.id);
    const existing = bidsByWorkOrderId[row.id];
    setDraftById((prev) => ({ ...prev, [row.id]: prev[row.id] ?? defaultBidDraft(row, existing) }));
  };

  const submitBid = async (row: DemoManagerWorkOrderRow) => {
    const draft = draftById[row.id] ?? defaultBidDraft(row, bidsByWorkOrderId[row.id]);
    const amountCents = Math.round(parseMoneyAmount(draft.amount) * 100);
    const materialsCents = draft.materials.trim() ? Math.round(parseMoneyAmount(draft.materials) * 100) : 0;
    const proposedTimeIso = fromDatetimeLocalValue(draft.proposedTime);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      showToast("Enter a valid labor cost.");
      return;
    }
    if (!Number.isFinite(materialsCents) || materialsCents < 0) {
      showToast("Enter a valid equipment/materials cost.");
      return;
    }
    if (!proposedTimeIso) {
      showToast("Choose a date and time you'll do the work.");
      return;
    }
    setSubmittingId(row.id);
    try {
      if (demo) {
        upsertWorkOrderBid({
          workOrderId: row.id,
          vendorDirectoryId: row.vendorId ?? "demo-vendor-1",
          quoteMode: modeById[row.id] ?? "upfront",
          amountCents,
          materialsCents,
          proposedTime: proposedTimeIso,
          note: draft.note.trim() || null,
          status: "submitted",
        });
        await loadBids();
        showToast("Price submitted.");
        return;
      }
      const res = await fetch("/api/portal/work-order-bids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "submit",
          workOrderId: row.id,
          amountCents,
          materialsCents,
          proposedTime: proposedTimeIso,
          note: draft.note,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not submit bid.");
      await loadBids();
      showToast("Price submitted.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not submit bid.");
    } finally {
      setSubmittingId(null);
    }
  };

  const scheduleConsultation = async (row: DemoManagerWorkOrderRow, mode: "auto" | "manual") => {
    let consultationVisitAt: string | null = null;
    if (mode === "manual") {
      consultationVisitAt = fromDatetimeLocalValue(consultationDraftById[row.id] ?? "");
      if (!consultationVisitAt) {
        showToast("Choose a date and time for the consultation.");
        return;
      }
    }
    setSchedulingId(row.id);
    try {
      if (demo) {
        let visitAt = consultationVisitAt;
        if (mode === "auto") {
          const d = new Date();
          d.setDate(d.getDate() + 2);
          d.setHours(10, 0, 0, 0);
          visitAt = d.toISOString();
        }
        if (!visitAt) {
          showToast("Choose a date and time for the consultation.");
          return;
        }
        upsertWorkOrderBid({
          workOrderId: row.id,
          vendorDirectoryId: row.vendorId ?? "demo-vendor-1",
          quoteMode: "after_consultation",
          consultationVisitAt: visitAt,
          amountCents: null,
          materialsCents: 0,
          proposedTime: null,
          note: null,
          status: "submitted",
        });
        await loadBids();
        showToast(`Consultation scheduled for ${formatVisitLabel(visitAt)}.`);
        return;
      }
      const res = await fetch("/api/portal/work-order-bids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "schedule_consultation",
          workOrderId: row.id,
          mode,
          ...(consultationVisitAt ? { consultationVisitAt } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not schedule consultation.");
      await loadBids();
      showToast(`Consultation scheduled for ${formatVisitLabel(data.consultationVisitAt)}.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not schedule consultation.");
    } finally {
      setSchedulingId(null);
    }
  };

  const saveScheduledPrice = async (row: DemoManagerWorkOrderRow) => {
    const draft = draftById[row.id] ?? defaultBidDraft(row, bidsByWorkOrderId[row.id]);
    const amountCents = Math.round(parseMoneyAmount(draft.amount) * 100);
    const materialsCents = draft.materials.trim() ? Math.round(parseMoneyAmount(draft.materials) * 100) : 0;
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      showToast("Enter a valid labor cost.");
      return;
    }
    if (!Number.isFinite(materialsCents) || materialsCents < 0) {
      showToast("Enter a valid equipment/materials cost.");
      return;
    }

    setSavingPriceId(row.id);
    try {
      const totalCents = amountCents + materialsCents;
      if (demo) {
        updateManagerWorkOrder(row.id, (current) => ({
          ...current,
          vendorCostCents: amountCents,
          materialsCostCents: materialsCents,
          cost: `$${(totalCents / 100).toFixed(2)}`,
        }));
        setRows(readVendorWorkOrderRows());
        showToast("Price saved. Your manager will see this on payment.");
        return;
      }
      const res = await fetch("/api/portal/work-orders/set-vendor-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ workOrderId: row.id, amountCents, materialsCents }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save price.");
      await syncManagerWorkOrdersFromServer({ force: true });
      setRows(readVendorWorkOrderRows());
      showToast("Price saved. Your manager will see this on payment.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save price.");
    } finally {
      setSavingPriceId(null);
    }
  };

  const markDone = async (row: DemoManagerWorkOrderRow) => {
    setMarkingDoneId(row.id);
    try {
      const res = await fetch("/api/portal/work-orders/mark-done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ workOrderId: row.id, note: doneNoteById[row.id] ?? "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not mark done.");
      await syncManagerWorkOrdersFromServer({ force: true });
      showToast("Marked done. The manager has been notified.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not mark done.");
    } finally {
      setMarkingDoneId(null);
    }
  };

  const renderInvoice = (row: DemoManagerWorkOrderRow) => {
    const bid = bidsByWorkOrderId[row.id];
    // Fall back to the accepted bid when the row's own cents weren't mirrored,
    // so a completed job always shows what it earned.
    const laborCents = row.vendorCostCents || bid?.amountCents || 0;
    const materialsCents = row.materialsCostCents || bid?.materialsCents || 0;
    const totalCents = laborCents + materialsCents;
    const payout = payoutsByWorkOrderId[row.id];

    return (
      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Cost</p>
        <p className="mt-1.5 text-sm">
          <span className="font-semibold text-foreground">${(totalCents / 100).toFixed(2)}</span>
          {materialsCents > 0 ? (
            <span className="text-xs text-muted">
              {" "}
              (labor ${(laborCents / 100).toFixed(2)} + materials ${(materialsCents / 100).toFixed(2)})
            </span>
          ) : null}
        </p>
        {row.automationStatus !== "paid" ? (
          <p className="mt-1 text-xs text-muted">Awaiting manager approval and payment.</p>
        ) : payout?.status === "paid" ? (
          <p className="mt-1 text-xs text-muted">
            Payout sent: ${(payout.amountCents / 100).toFixed(2)} on{" "}
            {new Date(payout.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            {payout.stripeTransferId ? ` · ${payout.stripeTransferId}` : ""}
          </p>
        ) : payout?.status === "failed" ? (
          <p className="mt-1 text-xs text-muted">
            Paid by the manager, but the payout to your bank couldn&apos;t be sent
            {payout.failureReason ? `: ${payout.failureReason}` : ""}. Check your{" "}
            <Link href="/vendor/payments" className="font-medium text-foreground underline underline-offset-2">
              Stripe payout setup
            </Link>
            .
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted">
            Paid by the manager.{" "}
            <Link href="/vendor/payments" className="font-medium text-foreground underline underline-offset-2">
              Connect Stripe
            </Link>{" "}
            to receive future payouts directly.
          </p>
        )}
      </div>
    );
  };

  const renderRowDetail = (row: DemoManagerWorkOrderRow) => {
    const bid = bidsByWorkOrderId[row.id];
    const draft = draftById[row.id] ?? defaultBidDraft(row, bid);
    const pricingPending = isPricingPendingBid(bid);
    const canEditBid = (row.biddingOpen || pricingPending) && (!bid || bid.status === "submitted");
    const canMarkDone = row.bucket === "scheduled" && !row.automationStatus;
    const mode = bid?.quoteMode ?? modeById[row.id] ?? "upfront";
    const consultationScheduled = Boolean(bid?.consultationVisitAt);
    const showModeToggle = canEditBid && !bid && row.biddingOpen;
    const showScheduleConsultation = canEditBid && !bid && mode === "after_consultation" && row.biddingOpen;
    const showPricingFields = canEditBid && (mode === "upfront" || consultationScheduled || pricingPending);
    const showScheduledPrice = canMarkDone && !showPricingFields;

    return (
      <>
        <p className="text-sm leading-relaxed text-muted">{row.description}</p>
        {row.bucket !== "open" && row.scheduled && row.scheduled !== "—" ? (
          <p className="mt-1.5 text-xs text-muted">
            Visit scheduled for <span className="font-medium text-foreground">{row.scheduled}</span>
          </p>
        ) : null}
        {row.automationStatus === "vendor_marked_done" ? (
          <p className="mt-1.5 text-xs font-medium text-muted">Marked done. Awaiting manager approval.</p>
        ) : row.automationStatus === "paid" ? (
          <p className="mt-1.5 text-xs font-medium text-muted">Approved and paid.</p>
        ) : null}

        {row.bucket === "completed" ? renderInvoice(row) : null}

        {row.biddingOpen || bid ? (
          <div className="mt-4 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Quote</p>
              {bid ? (
                <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]">
                  {bid.quoteMode === "after_consultation" ? "After consultation" : "Upfront"}
                </span>
              ) : null}
            </div>

            {bid && !canEditBid ? (
              <p className="mt-1.5 text-xs text-muted">
                Your quote:{" "}
                <span className="font-medium text-foreground">
                  ${(((bid.amountCents ?? 0) + bid.materialsCents) / 100).toFixed(2)}
                </span>{" "}
                <span className="text-muted">
                  (labor ${((bid.amountCents ?? 0) / 100).toFixed(2)} + materials ${(bid.materialsCents / 100).toFixed(2)})
                </span>{" "}
                · {bid.proposedTime ? formatVisitLabel(bid.proposedTime) : "—"} ·{" "}
                <span className={bid.status === "accepted" ? "font-semibold text-foreground" : "font-semibold text-muted"}>
                  {bid.status}
                </span>
              </p>
            ) : null}

            {showModeToggle ? (
              <div className={`${PORTAL_TOOLBAR_GROUP} mt-2`} role="tablist" aria-label="Pricing mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "upfront"}
                  data-attr="vendor-quote-mode-upfront"
                  className={`${PORTAL_TOOLBAR_PILL_BUTTON} ${mode === "upfront" ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : ""}`}
                  onClick={() => setModeById((prev) => ({ ...prev, [row.id]: "upfront" }))}
                >
                  Quote now
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "after_consultation"}
                  data-attr="vendor-quote-mode-consultation"
                  className={`${PORTAL_TOOLBAR_PILL_BUTTON} ${mode === "after_consultation" ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : ""}`}
                  onClick={() => setModeById((prev) => ({ ...prev, [row.id]: "after_consultation" }))}
                >
                  Consult first
                </button>
              </div>
            ) : null}

            {showScheduleConsultation ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted">Schedule a consultation visit, then come back to price the job.</p>
                <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                  <Button
                    type="button"
                    variant="primary"
                    data-attr="vendor-auto-schedule-consultation"
                    className={`${PORTAL_DETAIL_BTN} rounded-full`}
                    disabled={schedulingId === row.id}
                    onClick={() => scheduleConsultation(row, "auto")}
                  >
                    {schedulingId === row.id ? "Finding a slot…" : "Auto-schedule from my availability"}
                  </Button>
                  <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                    Or pick a time
                    <Input
                      type="datetime-local"
                      value={consultationDraftById[row.id] ?? ""}
                      onChange={(e) => setConsultationDraftById((prev) => ({ ...prev, [row.id]: e.target.value }))}
                      className="h-8 rounded-md text-sm"
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    data-attr="vendor-manual-schedule-consultation"
                    className={PORTAL_DETAIL_BTN}
                    disabled={schedulingId === row.id}
                    onClick={() => scheduleConsultation(row, "manual")}
                  >
                    Schedule
                  </Button>
                </div>
              </div>
            ) : null}

            {bid?.quoteMode === "after_consultation" && consultationScheduled ? (
              <p className="mt-2 text-xs text-muted">
                Consultation scheduled for{" "}
                <span className="font-medium text-foreground">{formatVisitLabel(bid.consultationVisitAt as string)}</span>
                {pricingPending ? ", pricing pending." : "."}
              </p>
            ) : null}

            {showPricingFields ? (
              <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-2">
                <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                  Labor cost
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder="$0"
                    value={draft.amount}
                    onChange={(e) =>
                      setDraftById((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] ?? defaultBidDraft(row, bid)), amount: e.target.value } }))
                    }
                    className="h-8 w-24 rounded-md text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                  Equipment / materials
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder="$0"
                    value={draft.materials}
                    onChange={(e) =>
                      setDraftById((prev) => ({
                        ...prev,
                        [row.id]: { ...(prev[row.id] ?? defaultBidDraft(row, bid)), materials: e.target.value },
                      }))
                    }
                    className="h-8 w-24 rounded-md text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                  When you can do it
                  <Input
                    type="datetime-local"
                    value={draft.proposedTime}
                    onChange={(e) =>
                      setDraftById((prev) => ({
                        ...prev,
                        [row.id]: { ...(prev[row.id] ?? defaultBidDraft(row, bid)), proposedTime: e.target.value },
                      }))
                    }
                    className="h-8 rounded-md text-sm"
                  />
                </label>
                <label className="flex flex-1 min-w-[160px] flex-col gap-1 text-[11px] font-medium text-muted">
                  Note (optional)
                  <Input
                    type="text"
                    placeholder="Anything the manager should know"
                    value={draft.note}
                    onChange={(e) =>
                      setDraftById((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] ?? defaultBidDraft(row, bid)), note: e.target.value } }))
                    }
                    className="h-8 rounded-md text-sm"
                  />
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        {showPricingFields ? (
          <PortalTableDetailActions>
            <Button
              type="button"
              variant="primary"
              data-attr="vendor-submit-bid"
              className={`${PORTAL_DETAIL_BTN} rounded-full`}
              disabled={submittingId === row.id}
              onClick={() => submitBid(row)}
            >
              {pricingPending ? "Submit price" : bid ? "Update bid" : "Submit bid"}
            </Button>
          </PortalTableDetailActions>
        ) : null}

        {canMarkDone ? (
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
              {showScheduledPrice ? (
                <>
                  <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                    Labor cost
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="$0"
                      value={draft.amount}
                      onChange={(e) =>
                        setDraftById((prev) => ({
                          ...prev,
                          [row.id]: { ...(prev[row.id] ?? defaultBidDraft(row, bid)), amount: e.target.value },
                        }))
                      }
                      className="h-8 w-24 rounded-md text-sm"
                      data-attr="vendor-scheduled-price-labor"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                    Materials
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="$0"
                      value={draft.materials}
                      onChange={(e) =>
                        setDraftById((prev) => ({
                          ...prev,
                          [row.id]: { ...(prev[row.id] ?? defaultBidDraft(row, bid)), materials: e.target.value },
                        }))
                      }
                      className="h-8 w-24 rounded-md text-sm"
                      data-attr="vendor-scheduled-price-materials"
                    />
                  </label>
                </>
              ) : null}
              <label className="flex flex-1 min-w-[160px] flex-col gap-1 text-[11px] font-medium text-muted">
                Note (optional)
                <Input
                  type="text"
                  placeholder="Anything the manager should know"
                  value={doneNoteById[row.id] ?? ""}
                  onChange={(e) => setDoneNoteById((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  className="h-8 rounded-md text-sm"
                />
              </label>
            </div>
            <PortalTableDetailActions>
              {showScheduledPrice ? (
                <Button
                  type="button"
                  variant="outline"
                  className={`${PORTAL_DETAIL_BTN} rounded-full`}
                  data-attr="vendor-save-scheduled-price"
                  disabled={savingPriceId === row.id}
                  onClick={() => saveScheduledPrice(row)}
                >
                  {savingPriceId === row.id ? "Saving…" : "Save price"}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="primary"
                data-attr="vendor-mark-done"
                className={`${PORTAL_DETAIL_BTN} rounded-full`}
                disabled={markingDoneId === row.id}
                onClick={() => markDone(row)}
              >
                {markingDoneId === row.id ? "Marking done…" : "Mark done"}
              </Button>
            </PortalTableDetailActions>
          </div>
        ) : null}
      </>
    );
  };

  const emptyMessage =
    sorted.length === 0
      ? "No services offered to you yet."
      : tab === "quote"
        ? "Nothing needs a quote. New offers from your manager land here."
        : tab === "tour"
          ? "No site visits waiting for a price."
          : tab === "scheduled"
            ? "No confirmed jobs on the calendar yet."
            : "No completed jobs yet.";

  return (
    <ManagerPortalPageShell
      title="Services"
      hideTitleOnMobileNav
      filterRow={
        <ManagerPortalStatusPills tabs={tabs} activeId={tab} onChange={(id) => setTab(id as VendorWorkOrderTab)} />
      }
    >
      {bidsSyncFailed || payoutsSyncFailed ? (
        <p className="mb-4 rounded-xl border px-4 py-3 text-sm portal-banner-danger" data-attr="vendor-wo-sync-error">
          Couldn&apos;t refresh the latest bidding/payout status. This may be out of date. Retrying automatically.
        </p>
      ) : null}
      {visible.length === 0 ? (
        <PortalDataTableEmpty message={emptyMessage} icon="work-order" />
      ) : (
        <div>
          <div className="space-y-2 lg:hidden">
            {visible.map((row) => {
              const isExpanded = expandedId === row.id;
              const phaseLabel = vendorWorkOrderPhaseLabel(row, bidsByWorkOrderId[row.id]);
              return (
                <div key={`wo-mobile-${row.id}`} className={PORTAL_MOBILE_CARD_CLASS}>
                  <button
                    type="button"
                    className="flex w-full gap-2 text-left"
                    onClick={() => (isExpanded ? setExpandedId(null) : openExpand(row))}
                    aria-expanded={isExpanded}
                  >
                    <div className="min-w-0 flex-1">
                      <PortalTableInlineExpand expanded={isExpanded} className="font-semibold text-foreground">
                        <span className="truncate">{row.title}</span>
                      </PortalTableInlineExpand>
                      <p className="mt-0.5 truncate text-xs text-muted">{propertyLabel(row)}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <WorkOrderStatusBadge bucket={row.bucket} />
                      </div>
                      {/* Same reason as the desktop table: the bucket badge is the
                          manager-side state, so a job this vendor already quoted reads
                          identically to an untouched one. This branch is what the
                          Capacitor iOS app renders, so the label has to be here too. */}
                      {phaseLabel ? <p className="mt-1 text-xs text-muted">{phaseLabel}</p> : null}
                    </div>
                  </button>
                  {isExpanded ? <div className="mt-3 border-t border-border pt-3">{renderRowDetail(row)}</div> : null}
                </div>
              );
            })}
          </div>
          <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
            <div className={PORTAL_DATA_TABLE_SCROLL}>
              <table className={PORTAL_DATA_TABLE}>
                <PortalDataTableColGroup percents={portalTableColumnPercents(4)} />
                <thead>
                  <tr className={PORTAL_TABLE_HEAD_ROW}>
                    <th className={MANAGER_TABLE_TH}>Service</th>
                    <th className={MANAGER_TABLE_TH}>Property</th>
                    <th className={MANAGER_TABLE_TH}>Scheduled visit</th>
                    <th className={MANAGER_TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => {
                    const isExpanded = expandedId === row.id;
                    const phaseLabel = vendorWorkOrderPhaseLabel(row, bidsByWorkOrderId[row.id]);
                    return (
                      <Fragment key={row.id}>
                        <tr
                          id={`portal-work-order-${row.id}`}
                          className={PORTAL_TABLE_TR_EXPANDABLE}
                          onClick={createPortalRowExpandClick(() => (isExpanded ? setExpandedId(null) : openExpand(row)))}
                          aria-expanded={isExpanded}
                        >
                          <td className={PORTAL_TABLE_TD}>
                            <PortalTableInlineExpand expanded={isExpanded} className="font-medium text-foreground">
                              {row.title}
                            </PortalTableInlineExpand>
                            {row.description ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{row.description}</p> : null}
                          </td>
                          <td className={PORTAL_TABLE_TD}>{propertyLabel(row)}</td>
                          <td className={PORTAL_TABLE_TD}>{row.scheduled || "Not yet scheduled"}</td>
                          <td className={PORTAL_TABLE_TD}>
                            <WorkOrderStatusBadge bucket={row.bucket} />
                            {/* The bucket badge is the manager-side state, so a job this
                                vendor has already quoted looks identical to one they
                                haven't. Surface the vendor's own next step too. */}
                            {phaseLabel ? <p className="mt-0.5 text-xs text-muted">{phaseLabel}</p> : null}
                          </td>
                        </tr>
                        {isExpanded ? (
                          <tr className={PORTAL_TABLE_DETAIL_ROW}>
                            <td colSpan={4} className={PORTAL_TABLE_DETAIL_CELL}>
                              {renderRowDetail(row)}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </ManagerPortalPageShell>
  );
}
