"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import { ServiceIntakePhotoPicker } from "@/components/portal/service-intake-form-fields";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { getSettingsEntryPoint } from "@/components/portal/settings-entry-points";
import { VendorSectionSettingsModal } from "@/components/portal/vendor-section-settings-modal";
import { VendorQuoteWizard } from "@/components/portal/vendor-quote-wizard";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ManagerPortalPageShell,

  PORTAL_TOOLBAR_GROUP,
  PORTAL_TOOLBAR_PILL_BUTTON,
  PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE,
} from "@/components/portal/portal-metrics";
import {
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
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
import { upsertWorkOrderBid, WORK_ORDER_BIDS_EVENT } from "@/lib/work-order-bids-storage";
import {
  declineWorkOrderVendorOffer,
  fetchWorkOrderVendorOffers,
  type WorkOrderVendorOffer,
} from "@/lib/work-order-vendor-offers";
import {
  isPricingPendingBid,
  vendorWorkOrderPhaseLabel,
  vendorWorkOrderTab,
  VENDOR_WORK_ORDER_TAB_LABELS,
  VENDOR_WORK_ORDER_TAB_ORDER,
  type VendorWorkOrderTab,
} from "@/lib/vendor-work-order-tabs";
import { vendorWorkOrderListHref, vendorJobDetailHref, type VendorJobDetailTabId } from "@/lib/portal-detail-routes";
import { portalEmptyCopy, portalEmptySibling } from "@/lib/portal-empty-copy";
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

const SAFE_PHOTO_HREF_RE = /^(?:data:image\/|https?:\/\/)/;

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
export function VendorWorkOrdersPanel({
  tabId = "pending",
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
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [savingPriceId, setSavingPriceId] = useState<string | null>(null);
  const [doneNoteById, setDoneNoteById] = useState<Record<string, string>>({});
  const [markingDoneId, setMarkingDoneId] = useState<string | null>(null);
  // N010: a completion photo is required before a job can be marked done —
  // reuses the same picker/data-URL pattern as the resident's own required
  // intake photo (ServiceIntakePhotoPicker), never a new upload mechanism.
  const [donePhotosById, setDonePhotosById] = useState<Record<string, string[]>>({});
  const [donePhotoErrorById, setDonePhotoErrorById] = useState<Record<string, boolean>>({});
  /** Chosen before a bid row exists — once scheduled/submitted, the row's own quoteMode wins. */
  const [modeById, setModeById] = useState<Record<string, "upfront" | "after_consultation">>({});
  const [consultationDraftById, setConsultationDraftById] = useState<Record<string, string>>({});
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const [bidsSyncFailed, setBidsSyncFailed] = useState(false);
  const [payoutsSyncFailed, setPayoutsSyncFailed] = useState(false);
  const [decliningOfferId, setDecliningOfferId] = useState<string | null>(null);
  const [withdrawingBidId, setWithdrawingBidId] = useState<string | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
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

  useEffect(() => {
    const sync = () => setRows(readVendorWorkOrderRows());
    const onBidsChanged = () => void loadBids();
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    window.addEventListener(WORK_ORDER_BIDS_EVENT, onBidsChanged);
    void syncManagerWorkOrdersFromServer().then(() => sync());
    void loadBids();
    void loadPayouts();
    void loadOffers();

    // Bidding state (open/accepted) and payout status can change server-side while this
    // tab sits idle (manager accepts another bid, a payout posts) — refresh on a short
    // poll and whenever the tab regains focus so they can't silently go stale.
    const refreshAll = () => {
      void syncManagerWorkOrdersFromServer({ force: true }).then(() => sync());
      void loadBids();
      void loadPayouts();
      void loadOffers();
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
  }, [loadBids, loadPayouts, loadOffers]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => (b.scheduledAtIso ?? "").localeCompare(a.scheduledAtIso ?? "")),
    [rows],
  );

  const tabCounts = useMemo(() => {
    const c: Record<VendorWorkOrderTab, number> = { pending: 0, upcoming: 0, past: 0 };
    for (const row of sorted) c[vendorWorkOrderTab(row, bidsByWorkOrderId[row.id])] += 1;
    return c;
  }, [sorted, bidsByWorkOrderId]);

  const tabs = useMemo(
    () =>
      VENDOR_WORK_ORDER_TAB_ORDER.map((id) => ({
        id,
        label: VENDOR_WORK_ORDER_TAB_LABELS[id],
        count: tabCounts[id],
        href: vendorWorkOrderListHref("/vendor", id),
        dataAttr: `vendor-wo-tab-${id}`,
      })),
    [tabCounts],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("add") !== "1") return;
    setQuoteOpen(true);
    router.replace(vendorWorkOrderListHref("/vendor", tabId));
  }, [router, tabId]);

  const visible = useMemo(
    () => sorted.filter((row) => vendorWorkOrderTab(row, bidsByWorkOrderId[row.id]) === tabId),
    [sorted, tabId, bidsByWorkOrderId],
  );

  const wizardJobs = useMemo(
    () => sorted.filter((row) => vendorWorkOrderTab(row, bidsByWorkOrderId[row.id]) === "pending"),
    [sorted, bidsByWorkOrderId],
  );

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
          vendorUserId: "demo-vendor-1",
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
          vendorUserId: "demo-vendor-1",
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

  /**
   * A job can be handed back to the manager in bulk only while it is scheduled
   * and no automation has already moved it — the same condition the row's own
   * "Mark done" button uses, read from one place so the dock and the row can
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
      showToast("Add a completion photo before marking this service done.");
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
      if (!res.ok) throw new Error(data.error ?? "Could not mark done.");
      await syncManagerWorkOrdersFromServer({ force: true });
      setDonePhotosById((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      showToast("Marked done. The manager has been notified.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not mark done.");
    } finally {
      setMarkingDoneId(null);
    }
  };

  const declineOffer = async (row: DemoManagerWorkOrderRow, offer: WorkOrderVendorOffer) => {
    setDecliningOfferId(offer.id);
    try {
      if (demo) {
        setOffersByWorkOrderId((prev) => {
          const next = { ...prev };
          delete next[row.id];
          return next;
        });
        showToast("Offer declined.");
        return;
      }
      const result = await declineWorkOrderVendorOffer(offer.id);
      if (!result.ok) throw new Error(result.error ?? "Could not decline offer.");
      await loadOffers();
      showToast("Offer declined.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not decline offer.");
    } finally {
      setDecliningOfferId(null);
    }
  };

  const withdrawBid = async (row: DemoManagerWorkOrderRow) => {
    setWithdrawingBidId(row.id);
    try {
      if (demo) {
        setBidsByWorkOrderId((prev) => {
          const next = { ...prev };
          delete next[row.id];
          return next;
        });
        showToast("Bid withdrawn.");
        return;
      }
      const res = await fetch("/api/portal/work-order-bids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "withdraw", workOrderId: row.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not withdraw bid.");
      await loadBids();
      setDraftById((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      showToast("Bid withdrawn.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not withdraw bid.");
    } finally {
      setWithdrawingBidId(null);
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

  const renderRowDetail = (row: DemoManagerWorkOrderRow) => {
    const bid = bidsByWorkOrderId[row.id];
    const offer = offersByWorkOrderId[row.id];
    const offerDeclined = offer?.status === "declined";
    const canDeclineOffer = offer?.status === "sent" && row.biddingOpen && !bid;
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

        {offerDeclined ? (
          <p className="mt-1.5 text-xs font-medium text-muted">You declined this offer.</p>
        ) : null}

        {row.bucket === "completed" ? renderInvoice(row) : null}

        {canDeclineOffer && offer ? (
          <div className="mt-3 border-t border-border pt-3">
            <p className="text-xs text-muted">Not available or not interested?</p>
            <Button
              type="button"
              variant="outline"
              className={`${PORTAL_DETAIL_BTN} mt-2`}
              data-attr="vendor-decline-offer"
              disabled={decliningOfferId === offer.id}
              onClick={() => declineOffer(row, offer)}
            >
              {decliningOfferId === offer.id ? "Declining…" : "Decline offer"}
            </Button>
          </div>
        ) : null}

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
            {bid && bid.status === "submitted" ? (
              <Button
                type="button"
                variant="outline"
                data-attr="vendor-withdraw-bid"
                className={PORTAL_DETAIL_BTN}
                disabled={withdrawingBidId === row.id}
                onClick={() => withdrawBid(row)}
              >
                {withdrawingBidId === row.id ? "Withdrawing…" : "Withdraw bid"}
              </Button>
            ) : null}
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
            <div className="space-y-2">
              <ServiceIntakePhotoPicker onPick={() => openDonePhotoPicker(row.id)} disabled={markingDoneId === row.id} />
              {donePhotoErrorById[row.id] ? (
                <p className="text-xs font-medium text-[var(--status-overdue-fg)]" data-attr="vendor-mark-done-photo-error">
                  Add a completion photo before marking this service done.
                </p>
              ) : null}
              {(donePhotosById[row.id] ?? []).length ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {(donePhotosById[row.id] ?? []).map((src, i) => (
                    <div key={i} className="overflow-hidden rounded-xl border border-border bg-accent/30">
                      <Image
                        src={src}
                        alt={`Completion photo ${i + 1}`}
                        width={160}
                        height={120}
                        className="h-20 w-full object-cover"
                        unoptimized
                      />
                      <div className="flex justify-start p-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-7 rounded-full px-2.5 text-[11px]"
                          onClick={() => removeDonePhoto(row.id, i)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
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

  if (workOrderId) {
    const row = sorted.find((r) => r.id === workOrderId) ?? null;
    if (!row) {
      return <PortalDataTableEmpty icon="default" message="Job not found." />;
    }
    const activeTab: VendorJobDetailTabId = workOrderDetailTab ?? "overview";
    const backHref = vendorWorkOrderListHref("/vendor", tabId);
    const sections = recordSections("vendor", "job", { basePath: "/vendor" });
    const onHeaderAction = (actionId: string) => {
      // Accepting/pricing the job and submitting its invoice both live in the
      // same Bid / Invoice form — the header icon takes you to it rather than
      // re-implementing the form's validation a second time.
      if (actionId === "accept" || actionId === "submit-invoice") {
        navigate(vendorJobDetailHref("/vendor", row.id, "invoice"));
        return;
      }
      if (actionId === "schedule") {
        navigate(vendorJobDetailHref("/vendor", row.id, "schedule"));
      }
    };
    const bid = bidsByWorkOrderId[row.id];
    const ownContent =
      activeTab === "schedule" ? (
        <div className="px-3 pb-4 sm:px-4" data-attr="vendor-job-schedule">
          {row.scheduled && row.scheduled !== "—" ? (
            <p className="text-sm text-foreground">
              Visit scheduled for <span className="font-medium">{row.scheduled}</span>
            </p>
          ) : (
            <PortalListEmptyCard title="Not yet scheduled" workspaceAware={false} dataAttr="vendor-job-schedule-empty" />
          )}
          {row.entryPermission ? (
            <p className="mt-2 text-xs text-muted">
              Entry: {row.entryPermission}
              {row.entryNotes ? ` (${row.entryNotes})` : ""}
            </p>
          ) : null}
        </div>
      ) : activeTab === "invoice" ? (
        <div className="px-3 pb-4 sm:px-4" data-attr="vendor-job-bid-invoice">
          {renderRowDetail(row)}
        </div>
      ) : activeTab === "communication" ? (
        renderRecordSection("communication", {
          role: "vendor",
          kind: "job",
          kindLabel: "job",
          recordId: row.id,
          recordLabel: row.title,
        })
      ) : (
        <>
        {renderRecordSection("overview", {
          role: "vendor",
          kind: "job",
          kindLabel: "job",
          recordId: row.id,
          recordLabel: row.title,
          overviewTiles: [
            { id: "bid", label: "Your bid", value: bid?.amountCents ? `$${(bid.amountCents / 100).toFixed(0)}` : "—" },
            { id: "status", label: "Status", value: vendorWorkOrderPhaseLabel(row, bid) ?? "—" },
            { id: "visit", label: "Visit", value: row.scheduled && row.scheduled !== "—" ? String(row.scheduled) : "Not scheduled" },
            { id: "paid", label: "Paid", value: row.automationStatus === "paid" ? "Paid" : "$0" },
          ],
          overviewCards: [
            {
              id: "job",
              title: "Job",
              action: { label: "Schedule", href: vendorJobDetailHref("/vendor", row.id, "schedule") },
              rows: [
                { label: "Details", value: row.description || "—" },
                { label: "Access", value: row.entryPermission ? `${row.entryPermission}${row.entryNotes ? ` (${row.entryNotes})` : ""}` : "—" },
              ],
            },
            {
              id: "site",
              title: "Site",
              rows: [
                { label: "Property", value: propertyLabel(row) || "—" },
                { label: "Reference", value: row.reference || "—" },
              ],
            },
            {
              id: "payments",
              title: "Payments",
              kind: "rows",
              rows: [],
              emptyLabel: "No invoice yet",
              action: { label: "Invoice", href: vendorJobDetailHref("/vendor", row.id, "invoice") },
            },
          ],
        })}
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
      <PortalRecordDetailPage
        pageTitle="Services"
        title={row.title}
        subtitle={propertyLabel(row)}
        avatarName={row.title}
        backHref={backHref}
        backLabel="Back to services"
        hideBackText
        bareHeader
        iconTitleActions
        pinScrollBody
      >
        <PortalRecordActions>
          <PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onHeaderAction} />
        </PortalRecordActions>
        <PortalRecordSectionChrome
          sections={sections}
          recordId={row.id}
          activeId={activeTab}
          title={row.title}
          subtitle={propertyLabel(row)}
          backHref={backHref}
          backLabel="All services"
          ariaLabel="Job sections"
          onHeaderAction={onHeaderAction}
        >
          {ownContent}
        </PortalRecordSectionChrome>
      </PortalRecordDetailPage>
    );
  }

  const emptyCopy = portalEmptyCopy(`work-orders.${tabId}`);

  return (
    <ManagerPortalPageShell
      title="Services"
      hideTitleOnMobileNav
      titleInlineFilter={null}
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={tabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: tab.href,
          count: tab.count,
          dataAttr: tab.dataAttr,
        }))}
        activeDestinationId={tabId}
        destinationAriaLabel="Service status"
        actions={
          <PortalIconAction
            icon={Settings}
            label={servicesSettingsEntry.label}
            data-attr={servicesSettingsEntry.dataAttr}
            onClick={() => setSettingsOpen(true)}
          />
        }
        primary={
          <PortalPrimaryIconAction
            label="Add quote"
            data-attr="vendor-services-add"
            onClick={() => setQuoteOpen(true)}
          />
        }
      />
      {bidsSyncFailed || payoutsSyncFailed ? (
        <p className="mb-4 rounded-xl border px-4 py-3 text-sm portal-banner-danger" data-attr="vendor-wo-sync-error">
          Couldn&apos;t refresh the latest bidding/payout status. This may be out of date. Retrying automatically.
        </p>
      ) : null}
      <PortalRecordListSurface
        isEmpty={visible.length === 0}
        emptyCard={{
          title: emptyCopy.title,
          section: emptyCopy.section,
          sibling: portalEmptySibling(tabs, tabId),
          actions: [{ label: "Add quote", onClick: () => setQuoteOpen(true), dataAttr: "vendor-services-empty-add" }],
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
                Mark done
              </Button>
            </div>
          ) : null
        }
        dataAttr="vendor-services-list"
      >
        {visible.map((row) => {
          const phaseLabel = vendorWorkOrderPhaseLabel(row, bidsByWorkOrderId[row.id]);
          return (
            <div key={row.id} id={`portal-work-order-${row.id}`}>
              <PortalServiceRecordRow
                title={row.title}
                subtitle={[row.reference, propertyLabel(row), row.scheduled || "Not yet scheduled", phaseLabel]
                  .filter(Boolean)
                  .join(" · ")}
                checked={selectedIds.has(row.id)}
                // Only a scheduled job can be marked done in bulk, so only those
                // rows offer a checkbox. A checkbox that selects a row nothing
                // can act on is a promise the dock cannot keep.
                onSelectedChange={canBulkMarkDone(row) ? () => toggleSelected(row.id) : undefined}
                onOpen={() => navigate(vendorJobDetailHref("/vendor", row.id))}
                dataAttr="vendor-service-row"
              />
            </div>
          );
        })}
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
