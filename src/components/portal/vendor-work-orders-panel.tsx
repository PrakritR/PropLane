"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, Clock, MessageSquare, Navigation, Send, Settings, Sparkles, type LucideIcon } from "lucide-react";
import { ServiceIntakePhotoPicker } from "@/components/portal/service-intake-form-fields";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { getSettingsEntryPoint } from "@/components/portal/settings-entry-points";
import { VendorSectionSettingsModal } from "@/components/portal/vendor-section-settings-modal";
import { VendorQuoteWizard } from "@/components/portal/vendor-quote-wizard";
import { VendorEstimateBidSection } from "@/components/portal/vendor-estimate-bid-section";
import { RecordBandFilter, RecordTabBand } from "@/components/portal/record-list-band";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ManagerPortalPageShell,

} from "@/components/portal/portal-metrics";
import {
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { VendorServiceCardRow } from "@/components/portal/pro-service-card-row";
import { formatPortalRowDate } from "@/lib/portal-display-dates";
import { workOrderCostCents, formatServiceMoney } from "@/lib/manager-service-workflow";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";

import { readVendorWorkOrderRows, syncManagerWorkOrdersFromServer, MANAGER_WORK_ORDERS_EVENT, updateManagerWorkOrder } from "@/lib/manager-work-orders-storage";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { parseMoneyAmount } from "@/lib/household-charges";
import { fetchWorkOrderBidsResult, type WorkOrderBid } from "@/lib/work-order-bids";
import { fetchVendorPayoutsResult, type VendorPayout } from "@/lib/vendor-payouts";
import { vendorPayoutTimeline } from "@/lib/vendor-payout-timeline";
import { VendorPayoutTimeline } from "@/components/portal/vendor-payout-timeline";
import { WORK_ORDER_BIDS_EVENT } from "@/lib/work-order-bids-storage";
import {
  declineWorkOrderVendorOffer,
  fetchWorkOrderVendorOffers,
  type WorkOrderVendorOffer,
} from "@/lib/work-order-vendor-offers";
import {
  vendorDefaultReply,
  vendorEffectiveReply,
  vendorNextStep,
  vendorServiceFact,
  vendorServiceStage,
  vendorShortWhen as vendorShortWhenLabel,
  VENDOR_WORK_ORDER_TABS,
  type VendorWorkOrderTab,
} from "@/lib/vendor-work-order-tabs";
import type { VendorReplyChoice } from "@/lib/work-order-bid-cycle";
import { vendorWorkOrderListHref, vendorJobDetailHref, type VendorJobDetailTabId } from "@/lib/portal-detail-routes";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling } from "@/lib/portal-empty-copy";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  vendorCanSeeFullWorkOrderSite,
  vendorLeadMapsQuery,
  workOrderGeneralArea,
} from "@/lib/work-order-vendor-privacy";
import { VENDOR_SERVICE_ACTION_LABEL } from "@/lib/service-lifecycle";
import type { VendorInvoice } from "@/lib/vendor-invoices";

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

function vendorPlaceLine(row: DemoManagerWorkOrderRow, bid?: WorkOrderBid | null): string {
  if (vendorCanSeeFullWorkOrderSite(row, bid)) return propertyLabel(row);
  return workOrderGeneralArea(row);
}

/** The vendor's job amount: the accepted quote or recorded cost, nothing while it is only a quote. */
function vendorJobFigure(row: DemoManagerWorkOrderRow, bid?: WorkOrderBid | null): string | undefined {
  const cents = workOrderCostCents(row, bid?.status === "accepted" ? bid : null);
  return formatServiceMoney(cents) || undefined;
}

/** "$250" for whole dollars, "$130.65" otherwise — thousands separated, like the studio. */
function formatBudget(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
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

/**
 * Fully anchored over a charset with no HTML meta-characters. A prefix-only
 * scheme test still let `<` / `"` through into the href/src attribute, so it was
 * not a barrier (CodeQL js/xss-through-dom).
 */
const SAFE_PHOTO_HREF_RE =
  /^(?:data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%()[\]-]+)$/i;

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

/**
 * The vendor's Services: the list (Open · Assigned · Scheduled · Completed, the one service
 * vocabulary) and the vendor service page (Service · Estimate & bid · Schedule · Invoice ·
 * Communication) with ONE primary next step.
 */
export function VendorWorkOrdersPanel({
  tabId = "open",
  workOrderId,
  workOrderDetailTab,
}: {
  tabId?: VendorWorkOrderTab;
  /** A vendor job RECORD id (docs/agents/record-page.md); set only when routed to /work-orders/<id>/<tab>. */
  workOrderId?: string;
  workOrderDetailTab?: VendorJobDetailTabId;
}) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const navigate = usePortalNavigate();
  const demo = isDemoModeActive();
  const servicesSettingsEntry = getSettingsEntryPoint("vendorServices");
  const [rows, setRows] = useState<DemoManagerWorkOrderRow[]>(() => readVendorWorkOrderRows());
  const [bidsByWorkOrderId, setBidsByWorkOrderId] = useState<Record<string, WorkOrderBid>>({});
  const [offersByWorkOrderId, setOffersByWorkOrderId] = useState<Record<string, WorkOrderVendorOffer>>({});
  const [payoutsByWorkOrderId, setPayoutsByWorkOrderId] = useState<Record<string, VendorPayout>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [draftById, setDraftById] = useState<Record<string, BidDraft>>({});
  const [savingPriceId, setSavingPriceId] = useState<string | null>(null);
  const [doneNoteById, setDoneNoteById] = useState<Record<string, string>>({});
  const [markingDoneId, setMarkingDoneId] = useState<string | null>(null);
  // N010: a completion photo is required before a job can be marked done —
  // reuses the same picker/data-URL pattern as the resident's own required
  // intake photo (ServiceIntakePhotoPicker), never a new upload mechanism.
  const [donePhotosById, setDonePhotosById] = useState<Record<string, string[]>>({});
  const [donePhotoErrorById, setDonePhotoErrorById] = useState<Record<string, boolean>>({});
  const [bidsSyncFailed, setBidsSyncFailed] = useState(false);
  const [payoutsSyncFailed, setPayoutsSyncFailed] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [replyChoice, setReplyChoice] = useState<VendorReplyChoice | null>(null);
  const [invoicedIds, setInvoicedIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const answerSubmitRef = useRef<(() => void) | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const loadOffers = useCallback(async () => {
    const offers = await fetchWorkOrderVendorOffers();
    setOffersByWorkOrderId(Object.fromEntries(offers.map((o) => [o.workOrderId, o])));
  }, []);

  const loadInvoices = useCallback(async () => {
    if (demo) return;
    try {
      const res = await fetch("/api/vendor/invoices", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { invoices?: VendorInvoice[] };
      setInvoicedIds(
        new Set(
          (data.invoices ?? [])
            .filter((invoice) => invoice.workOrderId && invoice.status !== "rejected")
            .map((invoice) => invoice.workOrderId as string),
        ),
      );
    } catch {
      // The row simply reads "No invoice yet" until the next refresh.
    }
  }, [demo]);

  useEffect(() => {
    const sync = () => setRows(readVendorWorkOrderRows());
    const onBidsChanged = () => void loadBids();
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    window.addEventListener(WORK_ORDER_BIDS_EVENT, onBidsChanged);
    void syncManagerWorkOrdersFromServer().then(() => sync());
    void loadBids();
    void loadPayouts();
    void loadOffers();
    void loadInvoices();

    // Bidding state (open/accepted) and payout status can change server-side while this
    // tab sits idle (manager accepts another bid, a payout posts) — refresh on a short
    // poll and whenever the tab regains focus so they can't silently go stale.
    const refreshAll = () => {
      void syncManagerWorkOrdersFromServer({ force: true }).then(() => sync());
      void loadBids();
      void loadPayouts();
      void loadOffers();
      void loadInvoices();
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
  }, [loadBids, loadPayouts, loadOffers, loadInvoices]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => (b.scheduledAtIso ?? "").localeCompare(a.scheduledAtIso ?? "")),
    [rows],
  );

  const stageOf = useCallback(
    (row: DemoManagerWorkOrderRow) => vendorServiceStage(row, bidsByWorkOrderId[row.id], offersByWorkOrderId[row.id]),
    [bidsByWorkOrderId, offersByWorkOrderId],
  );

  const tabCounts = useMemo(() => {
    const c: Record<VendorWorkOrderTab, number> = { open: 0, assigned: 0, scheduled: 0, completed: 0 };
    for (const row of sorted) c[stageOf(row)] += 1;
    return c;
  }, [sorted, stageOf]);

  const tabs = useMemo(
    () => VENDOR_WORK_ORDER_TABS.map(({ id, label }) => ({ id, label, count: tabCounts[id], href: vendorWorkOrderListHref("/vendor", id) })),
    [tabCounts],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("add") !== "1") return;
    setQuoteOpen(true);
    router.replace(vendorWorkOrderListHref("/vendor", tabId));
  }, [router, tabId]);

  const propertyOptions = useMemo(
    () =>
      [...new Set(sorted.map((row) => row.propertyName).filter((name) => name && name !== "—"))]
        .sort()
        .map((name) => ({ value: name, label: name })),
    [sorted],
  );

  const visible = useMemo(
    () =>
      sorted.filter(
        (row) =>
          stageOf(row) === tabId &&
          (!propertyFilter || row.propertyName === propertyFilter) &&
          matchesPortalListSearch(search, row.title, row.propertyName, row.unit),
      ),
    [sorted, tabId, stageOf, propertyFilter, search],
  );

  const { nearYouRows, otherOpenRows } = useMemo(() => {
    if (tabId !== "open") return { nearYouRows: [] as DemoManagerWorkOrderRow[], otherOpenRows: visible };
    const near: DemoManagerWorkOrderRow[] = [];
    const rest: DemoManagerWorkOrderRow[] = [];
    for (const row of visible) {
      const offer = offersByWorkOrderId[row.id];
      if (offer?.status === "sent" && row.biddingOpen && !bidsByWorkOrderId[row.id]) near.push(row);
      else rest.push(row);
    }
    return { nearYouRows: near, otherOpenRows: rest };
  }, [visible, tabId, offersByWorkOrderId, bidsByWorkOrderId]);

  const wizardJobs = useMemo(() => sorted.filter((row) => stageOf(row) === "open"), [sorted, stageOf]);

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

  /**
   * A job can be handed back to the manager in bulk only while it is scheduled
   * and no automation has already moved it — the same condition the row's own
   * "Complete" button uses, read from one place so the dock and the row can
   * never disagree about what is actionable.
   */
  const canBulkMarkDone = (row: DemoManagerWorkOrderRow) =>
    row.bucket === "scheduled" && !row.automationStatus;

  /** Selection only ever holds rows the dock can act on. */
  const selectedDoneable = visible.filter((row) => selectedIds.has(row.id) && canBulkMarkDone(row));

  const markSelectedDone = async () => {
    for (const row of selectedDoneable) {
      await markDone(row);
    }
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });

  const openDonePhotoPicker = (rowId: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;width:0;height:0;";
    input.setAttribute("tabindex", "-1");
    input.setAttribute("aria-hidden", "true");
    const onChange = () => {
      void onPickDonePhotos(rowId, input.files);
      input.removeEventListener("change", onChange);
      input.remove();
    };
    input.addEventListener("change", onChange);
    document.body.appendChild(input);
    input.click();
  };

  const onPickDonePhotos = async (rowId: string, files: FileList | null) => {
    if (!files?.length) return;
    const current = donePhotosById[rowId] ?? [];
    const remaining = 6 - current.length;
    if (remaining <= 0) {
      showToast("Up to 6 photos.");
      return;
    }
    const next = [...current];
    for (let i = 0; i < Math.min(files.length, remaining); i++) {
      const file = files[i];
      if (!file) continue;
      if (!file.type.startsWith("image/")) {
        showToast("Images only.");
        return;
      }
      next.push(await fileToDataUrl(file));
    }
    setDonePhotosById((prev) => ({ ...prev, [rowId]: next }));
    if (next.length > 0) setDonePhotoErrorById((prev) => ({ ...prev, [rowId]: false }));
  };

  const removeDonePhoto = (rowId: string, index: number) => {
    setDonePhotosById((prev) => ({
      ...prev,
      [rowId]: (prev[rowId] ?? []).filter((_, i) => i !== index),
    }));
  };

  const markDone = async (row: DemoManagerWorkOrderRow) => {
    const completionPhotos = donePhotosById[row.id] ?? [];
    if (completionPhotos.length === 0) {
      setDonePhotoErrorById((prev) => ({ ...prev, [row.id]: true }));
      showToast("Add a completion photo before you complete this service.");
      return;
    }
    setMarkingDoneId(row.id);
    try {
      const res = await fetch("/api/portal/work-orders/mark-done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          workOrderId: row.id,
          note: doneNoteById[row.id] ?? "",
          completionPhotoDataUrls: completionPhotos,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not complete.");
      await syncManagerWorkOrdersFromServer({ force: true });
      setDonePhotosById((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      showToast("Completed. The manager has been notified.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not complete.");
    } finally {
      setMarkingDoneId(null);
    }
  };

  const declineOffer = async (row: DemoManagerWorkOrderRow, offer: WorkOrderVendorOffer, reason?: string) => {
    try {
      if (demo) {
        setOffersByWorkOrderId((prev) => {
          const next = { ...prev };
          delete next[row.id];
          return next;
        });
        showToast("Declined.");
        return;
      }
      const result = await declineWorkOrderVendorOffer(offer.id, reason);
      if (!result.ok) throw new Error(result.error ?? "Could not decline.");
      await loadOffers();
      showToast("Declined.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not decline.");
    }
  };

  const withdrawBid = async (row: DemoManagerWorkOrderRow) => {
    try {
      if (demo) {
        setBidsByWorkOrderId((prev) => {
          const next = { ...prev };
          delete next[row.id];
          return next;
        });
        showToast("Declined.");
        return;
      }
      const res = await fetch("/api/portal/work-order-bids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "withdraw", workOrderId: row.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not decline.");
      await loadBids();
      setDraftById((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      showToast("Declined.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not decline.");
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
        ) : payout ? (
          <div className="mt-2">
            <VendorPayoutTimeline
              steps={vendorPayoutTimeline({ payout, workOrder: { paidAt: row.paidAt } })}
              dataAttr="vendor-work-order-payout-timeline"
            />
            {payout.status === "failed" ? (
              <p className="mt-1 text-xs text-muted">
                Paid by the manager, but the payout to your bank couldn&apos;t be sent. Check your{" "}
                <Link href="/vendor/financials/payouts" className="font-medium text-foreground underline underline-offset-2">
                  Stripe payout setup
                </Link>
                .
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted">
            Paid by the manager.{" "}
            <Link href="/vendor/financials/payouts" className="font-medium text-foreground underline underline-offset-2">
              Connect Stripe
            </Link>{" "}
            to receive future payouts directly.
          </p>
        )}
      </div>
    );
  };

  /** Schedule's completion form: price, a note and the required completion photo, then Complete. */
  const renderCompleteForm = (row: DemoManagerWorkOrderRow) => {
    const bid = bidsByWorkOrderId[row.id];
    const draft = draftById[row.id] ?? defaultBidDraft(row, bid);
    const patchDraft = (patch: Partial<BidDraft>) =>
      setDraftById((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] ?? defaultBidDraft(row, bid)), ...patch } }));
    return (
      <div className="mt-3 space-y-3 border-t border-border pt-3" data-attr="vendor-job-complete">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
            Labor
            <Input
              type="text"
              inputMode="decimal"
              placeholder="$0"
              value={draft.amount}
              onChange={(e) => patchDraft({ amount: e.target.value })}
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
              onChange={(e) => patchDraft({ materials: e.target.value })}
              className="h-8 w-24 rounded-md text-sm"
              data-attr="vendor-scheduled-price-materials"
            />
          </label>
          <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[11px] font-medium text-muted">
            Note
            <Input
              type="text"
              placeholder="Optional"
              value={doneNoteById[row.id] ?? ""}
              onChange={(e) => setDoneNoteById((prev) => ({ ...prev, [row.id]: e.target.value }))}
              className="h-8 rounded-md text-sm"
            />
          </label>
        </div>
        <div className="space-y-2">
          <ServiceIntakePhotoPicker
            onPick={() => openDonePhotoPicker(row.id)}
            disabled={markingDoneId === row.id}
            photoCount={(donePhotosById[row.id] ?? []).length}
          />
          {donePhotoErrorById[row.id] ? (
            <p className="text-xs font-medium text-[var(--status-overdue-fg)]" data-attr="vendor-mark-done-photo-error">
              Add a completion photo before you complete this service.
            </p>
          ) : null}
          {(donePhotosById[row.id] ?? []).length ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {(donePhotosById[row.id] ?? []).map((src, i) => (
                <div key={i} className="overflow-hidden rounded-xl border border-border bg-accent/30">
                  <Image src={src} alt={`Completion photo ${i + 1}`} width={160} height={120} className="h-20 w-full object-cover" unoptimized />
                  <div className="flex justify-start p-1.5">
                    <Button type="button" variant="outline" className="h-7 rounded-full px-2.5 text-[11px]" onClick={() => removeDonePhoto(row.id, i)}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <PortalTableDetailActions>
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
          <Button
            type="button"
            variant="primary"
            data-attr="vendor-mark-done"
            className={`${PORTAL_DETAIL_BTN} rounded-full`}
            disabled={markingDoneId === row.id || (donePhotosById[row.id] ?? []).length === 0}
            onClick={() => markDone(row)}
          >
            {markingDoneId === row.id ? "Completing…" : VENDOR_SERVICE_ACTION_LABEL.complete}
          </Button>
        </PortalTableDetailActions>
      </div>
    );
  };

  if (workOrderId) {
    const row = sorted.find((r) => r.id === workOrderId) ?? null;
    if (!row) {
      return <PortalDataTableEmpty icon="default" message="Service not found." />;
    }
    const activeTab: VendorJobDetailTabId = workOrderDetailTab ?? "service";
    const bid = bidsByWorkOrderId[row.id];
    const offer = offersByWorkOrderId[row.id];
    const stage = vendorServiceStage(row, bid, offer);
    const invoiceSent = invoicedIds.has(row.id);
    const next = vendorNextStep({ row, bid, offer, invoiceSent });
    const reply = vendorEffectiveReply(replyChoice, bid, offer);
    const backHref = vendorWorkOrderListHref("/vendor", stage);
    const sections = recordSections("vendor", "job", { basePath: "/vendor" });
    const hasSite = vendorCanSeeFullWorkOrderSite(row, bid);
    const placeLine = vendorPlaceLine(row, bid);
    const declinable = stage === "open" && (offer?.status === "sent" || bid?.status === "submitted");
    const goTo = (section: VendorJobDetailTabId) => navigate(vendorJobDetailHref("/vendor", row.id, section));

    // ONE primary: the next step. On Estimate & bid it submits the form below under the same label.
    const primaryLabel = next ? (next.section === "bid" && reply ? reply.label : next.label) : null;
    const PrimaryIcon: LucideIcon = next?.id === "schedule" ? CalendarDays : next?.id === "complete" ? Check : Send;
    const onPrimary = () => {
      if (!next) return;
      if (next.id === "send_invoice") {
        setInvoiceOpen(true);
        return;
      }
      if (next.section === "bid") {
        if (activeTab === "bid" && answerSubmitRef.current) answerSubmitRef.current();
        else goTo("bid");
        return;
      }
      if (next.id === "complete" && activeTab === "schedule") {
        void markDone(row);
        return;
      }
      goTo(next.section);
    };
    const onDecline = () => {
      setReplyChoice(bid ? "cant_do_it" : "decline");
      goTo("bid");
    };

    const factRows: Array<{ label: string; value: string }> = [
      { label: "Service", value: row.title },
      { label: "Where", value: placeLine || "—" },
      { label: "Manager", value: row.managerName?.trim() || "—" },
    ];
    const answerBy = row.offerExpiresAt ? formatPortalRowDate(row.offerExpiresAt) : "";
    if (stage === "open" && answerBy) factRows.push({ label: "Answer by", value: answerBy });
    if (row.description?.trim()) factRows.push({ label: "Details", value: row.description.trim() });
    if (hasSite && row.residentName) factRows.push({ label: "Resident", value: row.residentName });
    if (hasSite && row.entryPermission) {
      factRows.push({ label: "Access", value: `${row.entryPermission}${row.entryNotes ? ` (${row.entryNotes})` : ""}` });
    }

    const canComplete = stage === "scheduled" && !row.automationStatus;
    const hasVisit = Boolean(row.scheduled && row.scheduled !== "—") || Boolean(row.scheduledAtIso);
    const invoiceOwed = stage === "completed" && !invoiceSent && row.automationStatus !== "paid" && !(bid?.status === "declined" || offer?.status === "declined");

    const ownContent =
      activeTab === "bid" ? (
        <VendorEstimateBidSection
          row={row}
          bid={bid}
          offer={offer}
          stage={stage}
          choice={reply?.value ?? vendorDefaultReply(bid)}
          onChoice={setReplyChoice}
          submitRef={answerSubmitRef}
          onSent={async () => {
            setReplyChoice(null);
            await loadBids();
          }}
          onDecline={async (reason) => {
            if (offer) await declineOffer(row, offer, reason);
          }}
          onWithdraw={() => withdrawBid(row)}
        />
      ) : activeTab === "schedule" ? (
        <div className="px-3 pb-4 sm:px-4" data-attr="vendor-job-schedule">
          {hasVisit ? (
            <p className="text-sm text-foreground">
              Visit <span className="font-medium">{row.scheduledAtIso ? vendorShortWhenLabel(row.scheduledAtIso) : row.scheduled}</span>
            </p>
          ) : (
            <PortalListEmptyCard title="Not yet scheduled" workspaceAware={false} dataAttr="vendor-job-schedule-empty" />
          )}
          {row.entryPermission && hasSite ? (
            <p className="mt-2 text-xs text-muted">
              Entry: {row.entryPermission}
              {row.entryNotes ? ` (${row.entryNotes})` : ""}
            </p>
          ) : null}
          {canComplete ? renderCompleteForm(row) : null}
        </div>
      ) : activeTab === "invoice" ? (
        <div className="px-3 pb-4 sm:px-4" data-attr="vendor-job-bid-invoice">
          {stage === "completed" && !(bid?.status === "declined" || offer?.status === "declined") ? (
            <>
              {renderInvoice(row)}
              {invoiceSent ? (
                <p className="mt-3 text-sm font-medium text-foreground" data-attr="vendor-job-invoice-sent">Invoice sent</p>
              ) : null}
              {invoiceOwed ? (
                <div className="mt-3">
                  <Button type="button" variant="primary" className={`${PORTAL_DETAIL_BTN} rounded-full`} data-attr="vendor-send-invoice" onClick={() => setInvoiceOpen(true)}>
                    {VENDOR_SERVICE_ACTION_LABEL.sendInvoice}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <PortalListEmptyCard title="No invoice yet" workspaceAware={false} dataAttr="vendor-job-invoice-empty" />
          )}
        </div>
      ) : activeTab === "communication" ? (
        renderRecordSection("communication", {
          role: "vendor",
          kind: "service",
          kindLabel: "service",
          recordId: row.id,
          recordLabel: row.title,
          contactName: row.managerName?.trim() || undefined,
        })
      ) : (
        <>
          {renderRecordSection("overview", {
            role: "vendor",
            kind: "service",
            kindLabel: "service",
            recordId: row.id,
            recordLabel: row.title,
            overviewCards: [{ id: "service", title: "Service", rows: factRows }],
          })}
          <div className="flex justify-end px-3 pb-3 pt-1 sm:px-4">
            <PortalIconAction
              icon={Navigation}
              label="Directions"
              data-attr="vendor-job-directions"
              onClick={() =>
                window.open(
                  hasSite && row.propertyAddress?.trim()
                    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(row.propertyAddress.trim())}`
                    : vendorLeadMapsQuery(row),
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            />
          </div>
          {row.photoDataUrls?.length ? (
            <div className="px-3 pb-4 sm:px-4" data-attr="vendor-job-photos">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Photos</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {row.photoDataUrls.map((src, i) => {
                  const trimmed = src.trim();
                  if (!SAFE_PHOTO_HREF_RE.test(trimmed)) return null;
                  return (
                    <a key={i} href={trimmed} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border bg-accent/30">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={trimmed} alt={`Photo ${i + 1}`} className="h-28 w-full object-cover" />
                    </a>
                  );
                })}
              </div>
            </div>
          ) : null}
        </>
      );
    return (
      <>
        <PortalRecordDetailPage
          pageTitle="Services"
          title={row.title}
          subtitle={placeLine}
          avatarName={row.title}
          backHref={backHref}
          backLabel="Back to services"
          hideBackText
          bareHeader
          iconTitleActions
          pinScrollBody
        >
          <PortalRecordActions>
            <div className="flex items-center justify-end gap-1">
              {/* Message · ⋯ (Decline) · the ONE primary next step. */}
              <PortalIconAction icon={MessageSquare} label="Message" data-attr="vendor-job-message" onClick={() => goTo("communication")} />
              {declinable ? (
                <RowActionsMenu
                  label="More"
                  items={[{ id: "decline", label: VENDOR_SERVICE_ACTION_LABEL.decline, onSelect: onDecline, dataAttr: "vendor-job-decline" }]}
                />
              ) : null}
              {next && primaryLabel ? (
                <PortalPrimaryIconAction icon={PrimaryIcon} label={primaryLabel} data-attr="vendor-job-primary" onClick={onPrimary} />
              ) : null}
            </div>
          </PortalRecordActions>
          <PortalRecordSectionChrome
            sections={sections}
            recordId={row.id}
            activeId={activeTab}
            title={row.title}
            subtitle={placeLine}
            backHref={backHref}
            backLabel="All services"
            ariaLabel="Service sections"
          >
            {ownContent}
          </PortalRecordSectionChrome>
        </PortalRecordDetailPage>
        <VendorQuoteWizard
          open={invoiceOpen}
          door="invoice"
          jobs={[row]}
          initialJobId={row.id}
          onClose={() => setInvoiceOpen(false)}
          onSubmitted={() => {
            setInvoiceOpen(false);
            void loadInvoices();
          }}
        />
      </>
    );
  }

  const emptyCopy = portalEmptyCopy(`work-orders.${tabId}`);
  const noMatchTitle = search.trim() || propertyFilter ? portalEmptyNoMatchTitle("services", search.trim()) : null;

  const renderRow = (row: DemoManagerWorkOrderRow, near = false) => {
    const bid = bidsByWorkOrderId[row.id];
    const offer = offersByWorkOrderId[row.id];
    const stage = vendorServiceStage(row, bid, offer);
    const fact = vendorServiceFact({ row, bid, offer, invoiceSent: invoicedIds.has(row.id) });
    const budgetCents = near ? (row.marketplacePublish?.budgetCents ?? 0) : 0;
    const factIcon = stage === "scheduled" ? CalendarDays : stage === "completed" ? Check : near && !bid ? Sparkles : Clock;
    return (
      <div key={row.id} id={`portal-work-order-${row.id}`}>
        <VendorServiceCardRow
          title={row.title}
          placeLine={vendorPlaceLine(row, bid)}
          dateText={fact}
          icon={factIcon}
          figure={budgetCents > 0 ? `${formatBudget(budgetCents)} budget` : vendorJobFigure(row, bid)}
          checked={selectedIds.has(row.id)}
          // Only a scheduled job can be completed in bulk, so only those rows offer a checkbox.
          // A checkbox that selects a row nothing can act on is a promise the dock cannot keep.
          onSelectedChange={canBulkMarkDone(row) ? () => toggleSelected(row.id) : undefined}
          onOpen={() => navigate(vendorJobDetailHref("/vendor", row.id))}
          dataAttr="vendor-service-row"
        />
      </div>
    );
  };

  return (
    <ManagerPortalPageShell
      title="Services"
      hideTitleOnMobileNav
      titleInlineFilter={null}
      compactFilterRow
    >
      <div className="mb-2 max-lg:mb-1.5">
        <RecordTabBand
          dataAttr="vendor-services-band"
          ariaLabel="Service status"
          tabs={tabs.map((tab) => ({ id: tab.id, label: tab.label, count: tab.count }))}
          activeId={tabId}
          onChange={(id) => navigate(vendorWorkOrderListHref("/vendor", id as VendorWorkOrderTab))}
          search={{ value: search, onChange: setSearch, placeholder: "Search services" }}
          actions={
            <>
              <RecordBandFilter
                dataAttr="vendor-services-band"
                fields={
                  propertyOptions.length > 0
                    ? [{ id: "property", label: "Property", anyLabel: "Any property", value: propertyFilter, options: propertyOptions, onChange: setPropertyFilter }]
                    : []
                }
              />
              <PortalIconAction
                icon={Settings}
                label={servicesSettingsEntry.label}
                data-attr={servicesSettingsEntry.dataAttr}
                onClick={() => setSettingsOpen(true)}
              />
            </>
          }
          plus={{ label: VENDOR_SERVICE_ACTION_LABEL.submitBid, onClick: () => setQuoteOpen(true), dataAttr: "vendor-services-add" }}
        />
      </div>
      {bidsSyncFailed || payoutsSyncFailed ? (
        <p className="mb-4 rounded-xl border px-4 py-3 text-sm portal-banner-danger" data-attr="vendor-wo-sync-error">
          Couldn&apos;t refresh the latest bidding/payout status. This may be out of date. Retrying automatically.
        </p>
      ) : null}
      <PortalRecordListSurface
        isEmpty={visible.length === 0}
        emptyCard={{
          title: noMatchTitle ?? emptyCopy.title,
          section: emptyCopy.section,
          sibling: noMatchTitle ? undefined : portalEmptySibling(tabs, tabId),
        }}
        onBulkClear={() => setSelectedIds(new Set())}
        bulkCount={selectedDoneable.length}
        bulkActions={
          selectedDoneable.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                disabled={Boolean(markingDoneId)}
                data-attr="vendor-wo-bulk-mark-done"
                onClick={() => void markSelectedDone()}
              >
                {VENDOR_SERVICE_ACTION_LABEL.complete}
              </Button>
            </div>
          ) : null
        }
        dataAttr="vendor-services-list"
      >
        {nearYouRows.length > 0 ? (
          <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">Near you</p>
        ) : null}
        {nearYouRows.map((row) => renderRow(row, true))}
        {(tabId === "open" ? otherOpenRows : visible).map((row) => renderRow(row))}
      </PortalRecordListSurface>
      <VendorQuoteWizard
        open={quoteOpen}
        door="quote"
        jobs={wizardJobs}
        onClose={() => setQuoteOpen(false)}
        onSubmitted={() => {
          setQuoteOpen(false);
          void loadBids();
        }}
      />
      <VendorSectionSettingsModal
        open={settingsOpen}
        title={servicesSettingsEntry.dialogTitle}
        onClose={() => setSettingsOpen(false)}
      />
    </ManagerPortalPageShell>
  );
}
