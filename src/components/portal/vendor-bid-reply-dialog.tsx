"use client";

import { useEffect, useMemo, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Textarea } from "@/components/ui/input";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { parseMoneyAmount } from "@/lib/household-charges";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { upsertWorkOrderBid } from "@/lib/work-order-bids-storage";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import { vendorReplyChoices, type VendorReplyChoice } from "@/lib/work-order-bid-cycle";
import { MAX_ESTIMATE_VISIT_FEE_CENTS } from "@/lib/work-order-visit-fee";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

const LABEL_CLASS = "mb-1 block text-xs font-medium text-muted";

function toCents(raw: string): number {
  return Math.round(parseMoneyAmount(raw) * 100);
}

function fromDatetimeLocal(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const PRIMARY_LABEL: Record<VendorReplyChoice, string> = {
  give_estimate: "Send estimate",
  book_estimate_visit: "Book visit",
  submit_bid: "Submit bid",
  complete_estimate_visit: "Visit done",
  decline: "Decline service",
  cant_do_it: "Withdraw",
};

/**
 * The vendor's answer to a request, in the standard popup frame. Choices follow where the vendor's
 * row stands (`vendorReplyChoices`): an ESTIMATE is a rough number that is never approvable; a BID
 * is the real price and time. Every amount is re-derived server-side - this only collects input.
 */
export function VendorBidReplyDialog({
  open,
  row,
  bid,
  onClose,
  onDone,
  onDecline,
  onWithdraw,
}: {
  open: boolean;
  row: DemoManagerWorkOrderRow | null;
  bid: WorkOrderBid | undefined;
  onClose: () => void;
  onDone: () => void | Promise<void>;
  /** Decline the offer (no bid row yet). */
  onDecline: () => void | Promise<void>;
  /** Withdraw an existing request row ("Can't do it"). */
  onWithdraw: () => void | Promise<void>;
}) {
  const { showToast } = useAppUi();
  const choices = useMemo(() => vendorReplyChoices(bid), [bid]);
  const [choice, setChoice] = useState<VendorReplyChoice>("submit_bid");
  const [estimate, setEstimate] = useState("");
  const [visitAt, setVisitAt] = useState("");
  const [visitFee, setVisitFee] = useState("");
  const [labor, setLabor] = useState("");
  const [materials, setMaterials] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChoice(choices[0]?.value ?? "submit_bid");
    setEstimate("");
    setVisitAt("");
    setVisitFee(bid?.estimateVisitFeeCents ? (bid.estimateVisitFeeCents / 100).toFixed(2) : "");
    setLabor("");
    setMaterials("");
    setWhen("");
    setNote("");
  }, [open, choices, bid?.estimateVisitFeeCents]);

  if (!row) return null;

  const post = async (payload: Record<string, unknown>, failure: string) => {
    const res = await fetch("/api/portal/work-order-bids", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ workOrderId: row.id, ...payload }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? failure);
    return data as Record<string, unknown>;
  };

  const submit = async () => {
    setBusy(true);
    try {
      const demo = isDemoModeActive();
      const demoBase = { workOrderId: row.id, vendorUserId: "demo-vendor-1", vendorDirectoryId: row.vendorId ?? "demo-vendor-1" };
      if (choice === "decline") {
        await onDecline();
        onClose();
        return;
      }
      if (choice === "cant_do_it") {
        await onWithdraw();
        onClose();
        return;
      }
      if (choice === "give_estimate") {
        const cents = toCents(estimate);
        if (!Number.isFinite(cents) || cents <= 0) throw new Error("Enter an estimate.");
        if (demo) upsertWorkOrderBid({ ...demoBase, estimateCents: cents, note: note.trim() || null, status: "submitted" });
        else await post({ action: "give_estimate", estimateCents: cents, note }, "Could not send the estimate.");
        showToast("Estimate sent.");
      } else if (choice === "book_estimate_visit") {
        const iso = fromDatetimeLocal(visitAt);
        const feeCents = visitFee.trim() ? toCents(visitFee) : 0;
        if (!Number.isFinite(feeCents) || feeCents < 0 || feeCents > MAX_ESTIMATE_VISIT_FEE_CENTS) throw new Error("Enter a valid visit fee.");
        if (demo) {
          if (!iso) throw new Error("Choose a date and time.");
          upsertWorkOrderBid({ ...demoBase, quoteMode: "after_consultation", consultationVisitAt: iso, estimateVisitFeeCents: feeCents, status: "submitted" });
        } else {
          await post(
            { action: "book_estimate_visit", mode: iso ? "manual" : "auto", ...(iso ? { consultationVisitAt: iso } : {}), visitFeeCents: feeCents },
            "Could not book the visit.",
          );
        }
        showToast("Estimate visit booked.");
      } else if (choice === "complete_estimate_visit") {
        if (demo) upsertWorkOrderBid({ ...demoBase, estimateVisitDoneAt: new Date().toISOString() });
        else await post({ action: "complete_estimate_visit" }, "Could not mark the visit done.");
        showToast("Visit marked done.");
      } else {
        const laborCents = toCents(labor);
        const materialsCents = materials.trim() ? toCents(materials) : 0;
        const iso = fromDatetimeLocal(when);
        if (!Number.isFinite(laborCents) || laborCents <= 0) throw new Error("Enter a valid labor cost.");
        if (!Number.isFinite(materialsCents) || materialsCents < 0) throw new Error("Enter a valid materials cost.");
        if (!iso) throw new Error("Choose when you can do the work.");
        if (demo) {
          upsertWorkOrderBid({ ...demoBase, amountCents: laborCents, materialsCents, proposedTime: iso, note: note.trim() || null, bidSubmittedAt: new Date().toISOString(), status: "submitted" });
        } else {
          await post({ action: "submit_bid", amountCents: laborCents, materialsCents, proposedTime: iso, note }, "Could not submit the bid.");
        }
        showToast("Bid submitted.");
      }
      await onDone();
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not send your reply.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalDialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissBlocked={busy}
      title="Reply"
      primaryAction={{ label: PRIMARY_LABEL[choice], onClick: () => void submit(), loading: busy, disabled: busy, dataAttr: "vendor-reply-submit" }}
    >
      <div className="space-y-4" data-attr="vendor-bid-reply">
        <FieldSingleSelect
          label="Reply"
          value={choice}
          options={choices}
          onChange={(next) => setChoice(next as VendorReplyChoice)}
          dataAttr="vendor-reply-choice"
        />
        {choice === "give_estimate" ? (
          <div>
            <label className={LABEL_CLASS} htmlFor="vendor-reply-estimate">Estimate</label>
            <Input id="vendor-reply-estimate" inputMode="decimal" placeholder="$0" value={estimate} onChange={(e) => setEstimate(e.target.value)} data-attr="vendor-reply-estimate" />
          </div>
        ) : null}
        {choice === "book_estimate_visit" ? (
          <>
            <div>
              <label className={LABEL_CLASS} htmlFor="vendor-reply-visit-at">Visit time</label>
              <Input id="vendor-reply-visit-at" type="datetime-local" value={visitAt} onChange={(e) => setVisitAt(e.target.value)} data-attr="vendor-reply-visit-at" />
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="vendor-reply-visit-fee">Visit fee</label>
              <Input id="vendor-reply-visit-fee" inputMode="decimal" placeholder="$0" value={visitFee} onChange={(e) => setVisitFee(e.target.value)} data-attr="vendor-reply-visit-fee" />
            </div>
          </>
        ) : null}
        {choice === "submit_bid" ? (
          <>
            <div>
              <label className={LABEL_CLASS} htmlFor="vendor-reply-labor">Labor</label>
              <Input id="vendor-reply-labor" inputMode="decimal" placeholder="$0" value={labor} onChange={(e) => setLabor(e.target.value)} data-attr="vendor-reply-labor" />
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="vendor-reply-materials">Materials</label>
              <Input id="vendor-reply-materials" inputMode="decimal" placeholder="$0" value={materials} onChange={(e) => setMaterials(e.target.value)} data-attr="vendor-reply-materials" />
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="vendor-reply-when">When you can do it</label>
              <Input id="vendor-reply-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} data-attr="vendor-reply-when" />
            </div>
          </>
        ) : null}
        {choice === "give_estimate" || choice === "submit_bid" ? (
          <div>
            <label className={LABEL_CLASS} htmlFor="vendor-reply-note">Note</label>
            <Textarea id="vendor-reply-note" value={note} onChange={(e) => setNote(e.target.value)} data-attr="vendor-reply-note" />
          </div>
        ) : null}
      </div>
    </PortalDialog>
  );
}
