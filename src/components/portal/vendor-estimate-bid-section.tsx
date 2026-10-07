"use client";

import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { ManagerResidentSectionToolbar } from "@/components/portal/manager-resident-section-toolbar";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { parseMoneyAmount } from "@/lib/household-charges";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { upsertWorkOrderBid } from "@/lib/work-order-bids-storage";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import type { VendorReplyChoice } from "@/lib/work-order-bid-cycle";
import { MAX_ESTIMATE_VISIT_FEE_CENTS } from "@/lib/work-order-visit-fee";
import { VENDOR_SERVICE_ACTION_LABEL, type ServiceStage } from "@/lib/service-lifecycle";
import { vendorAnswerChoices, vendorBidTabs, vendorShortWhen } from "@/lib/vendor-work-order-tabs";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

const LABEL_CLASS = "mb-1 block text-xs font-medium uppercase tracking-wide text-muted";

function toCents(raw: string): number {
  return Math.round(parseMoneyAmount(raw) * 100);
}

function fromDatetimeLocal(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
}

function SentRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

/**
 * Estimate & bid (record anatomy): a section header card whose underline tabs are the answers
 * `vendorReplyChoices` allows (Bid · Estimate visit · Decline), what the vendor already sent, then the
 * fields for the chosen tab with ONE commit button in the card's footer whose text equals the choice
 * label. Every amount is re-derived server-side; this only collects input and calls the existing
 * `/api/portal/work-order-bids` actions. The stage stepper lives in the record header, not here.
 */
export function VendorEstimateBidSection({
  row,
  bid,
  offer,
  stage,
  choice,
  onChoice,
  submitRef,
  onSent,
  onDecline,
  onWithdraw,
  onBusyChange,
}: {
  row: DemoManagerWorkOrderRow;
  bid: WorkOrderBid | undefined;
  offer: WorkOrderVendorOffer | undefined;
  stage: ServiceStage;
  choice: VendorReplyChoice;
  onChoice: (next: VendorReplyChoice) => void;
  /** The header's primary action calls this, so it submits the same form with the same label. */
  submitRef: MutableRefObject<(() => void) | null>;
  onSent: () => void | Promise<void>;
  /** Decline the offer (no bid row yet). */
  onDecline: (reason: string) => void | Promise<void>;
  /** Decline an existing request row (the vendor withdraws). */
  onWithdraw: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { showToast } = useAppUi();
  const choices = useMemo(() => vendorAnswerChoices(bid, offer), [bid, offer]);
  const bidTabs = useMemo(() => vendorBidTabs(bid, offer), [bid, offer]);
  const [estimate, setEstimate] = useState("");
  const [visitAt, setVisitAt] = useState("");
  const [visitFee, setVisitFee] = useState("");
  const [labor, setLabor] = useState("");
  const [materials, setMaterials] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVisitFee(bid?.estimateVisitFeeCents ? (bid.estimateVisitFeeCents / 100).toFixed(2) : "");
  }, [bid?.estimateVisitFeeCents]);

  const answering = stage === "open" && choices.length > 0;
  const active = choices.find((c) => c.value === choice) ?? choices[0];
  const activeValue = active?.value ?? choice;

  const laborCents = toCents(labor);
  const materialsCents = materials.trim() ? toCents(materials) : 0;
  const total = (Number.isFinite(laborCents) ? Math.max(laborCents, 0) : 0) + (Number.isFinite(materialsCents) ? Math.max(materialsCents, 0) : 0);

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
    if (busy || !answering) return;
    setBusy(true);
    onBusyChange?.(true);
    try {
      const demo = isDemoModeActive();
      const demoBase = { workOrderId: row.id, vendorUserId: "demo-vendor-1", vendorDirectoryId: row.vendorId ?? "demo-vendor-1" };
      if (activeValue === "decline") {
        await onDecline(reason);
        return;
      }
      if (activeValue === "cant_do_it") {
        await onWithdraw();
        return;
      }
      if (activeValue === "give_estimate") {
        const cents = toCents(estimate);
        if (!Number.isFinite(cents) || cents <= 0) throw new Error("Enter an estimate.");
        if (demo) upsertWorkOrderBid({ ...demoBase, estimateCents: cents, note: note.trim() || null, status: "submitted" });
        else await post({ action: "give_estimate", estimateCents: cents, note }, "Could not send the estimate.");
        showToast("Estimate sent.");
      } else if (activeValue === "book_estimate_visit") {
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
        showToast("Visit booked.");
      } else if (activeValue === "complete_estimate_visit") {
        if (demo) upsertWorkOrderBid({ ...demoBase, estimateVisitDoneAt: new Date().toISOString() });
        else await post({ action: "complete_estimate_visit" }, "Could not mark the visit done.");
        showToast("Visit done.");
      } else {
        const iso = fromDatetimeLocal(when);
        if (!Number.isFinite(laborCents) || laborCents <= 0) throw new Error("Enter a valid labor cost.");
        if (!Number.isFinite(materialsCents) || materialsCents < 0) throw new Error("Enter a valid materials cost.");
        if (!iso) throw new Error("Choose when you can start.");
        if (demo) {
          upsertWorkOrderBid({ ...demoBase, amountCents: laborCents, materialsCents, proposedTime: iso, note: note.trim() || null, bidSubmittedAt: new Date().toISOString(), status: "submitted" });
        } else {
          await post({ action: "submit_bid", amountCents: laborCents, materialsCents, proposedTime: iso, note }, "Could not submit the bid.");
        }
        showToast("Bid submitted.");
      }
      await onSent();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not send your answer.");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  useEffect(() => {
    submitRef.current = answering ? () => void submit() : null;
    return () => {
      submitRef.current = null;
    };
  });

  const sent: Array<{ label: string; value: string }> = [];
  if (bid?.estimateCents != null) {
    const on = bid.estimateGivenAt ? ` · ${vendorShortWhen(bid.estimateGivenAt).split(" · ")[0]}` : "";
    sent.push({ label: "Estimate", value: `${dollars(bid.estimateCents)}${on}` });
  }
  if (bid?.consultationVisitAt) {
    const fee = bid.estimateVisitFeeCents ? ` · ${dollars(bid.estimateVisitFeeCents)} fee` : "";
    sent.push({ label: "Visit", value: `${vendorShortWhen(bid.consultationVisitAt)}${fee}${bid.estimateVisitDoneAt ? " · done" : ""}` });
  }
  if (bid?.amountCents != null) {
    sent.push({ label: "Bid", value: `${dollars(bid.amountCents + bid.materialsCents)}${bid.proposedTime ? ` · can start ${vendorShortWhen(bid.proposedTime)}` : ""}` });
  }

  return (
    <div className="space-y-3 px-3 pb-4 sm:px-4" data-attr="vendor-estimate-bid">
      <ManagerResidentSectionToolbar
        actions={[]}
        onAction={() => undefined}
        className="rs40 plp-header-card"
        destinationRow={
          <LocalDestinationNav
            items={
              answering
                ? bidTabs.map((tab) => ({ id: tab.value, label: tab.label, dataAttr: `vendor-reply-choice-${tab.value}` }))
                : [{ id: "sent", label: "Your answer", dataAttr: "vendor-reply-choice-sent" }]
            }
            activeId={answering ? activeValue : "sent"}
            onChange={(id) => {
              if (!busy && answering) onChoice(id as VendorReplyChoice);
            }}
            ariaLabel="Your answer"
            appearance="command"
            className="w-full"
          />
        }
      />
      {sent.length > 0 ? (
        <div className="rounded-2xl border border-border bg-card px-4 py-1" data-attr="vendor-bid-sent">
          {sent.map((item) => (
            <SentRow key={item.label} label={item.label} value={item.value} />
          ))}
        </div>
      ) : null}
      {answering ? (
        <div className="rounded-2xl border border-border bg-card" data-attr="vendor-bid-answer">
          <div className="p-4">
          <div className="space-y-3">
            {activeValue === "give_estimate" ? (
              <div>
                <label className={LABEL_CLASS} htmlFor="vendor-reply-estimate">Estimate</label>
                <Input id="vendor-reply-estimate" inputMode="decimal" placeholder="$0" value={estimate} onChange={(e) => setEstimate(e.target.value)} data-attr="vendor-reply-estimate" />
              </div>
            ) : null}
            {activeValue === "book_estimate_visit" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-visit-at">Visit</label>
                  <Input id="vendor-reply-visit-at" type="datetime-local" value={visitAt} onChange={(e) => setVisitAt(e.target.value)} data-attr="vendor-reply-visit-at" />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-visit-fee">Visit fee</label>
                  <Input id="vendor-reply-visit-fee" inputMode="decimal" placeholder="$0" value={visitFee} onChange={(e) => setVisitFee(e.target.value)} data-attr="vendor-reply-visit-fee" />
                </div>
              </div>
            ) : null}
            {activeValue === "submit_bid" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-labor">Labor</label>
                  <Input id="vendor-reply-labor" inputMode="decimal" placeholder="$0" value={labor} onChange={(e) => setLabor(e.target.value)} data-attr="vendor-reply-labor" />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-materials">Materials</label>
                  <Input id="vendor-reply-materials" inputMode="decimal" placeholder="$0" value={materials} onChange={(e) => setMaterials(e.target.value)} data-attr="vendor-reply-materials" />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="vendor-reply-when">Can start</label>
                  <Input id="vendor-reply-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} data-attr="vendor-reply-when" />
                </div>
                <div>
                  <span className={LABEL_CLASS}>Total</span>
                  <p className="flex h-10 items-center text-sm font-bold text-foreground" data-attr="vendor-reply-total">{dollars(total)}</p>
                </div>
              </div>
            ) : null}
            {activeValue === "give_estimate" || activeValue === "submit_bid" ? (
              <div>
                <label className={LABEL_CLASS} htmlFor="vendor-reply-note">Note</label>
                {/* TODO(vendor-quick-replies-1006): add the quick-reply menu here (QuickReplyMenu, being built on claude-2-branch-4). */}
                <Textarea id="vendor-reply-note" placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} data-attr="vendor-reply-note" />
              </div>
            ) : null}
            {activeValue === "decline" ? (
              <div>
                <label className={LABEL_CLASS} htmlFor="vendor-reply-reason">Reason</label>
                <Textarea id="vendor-reply-reason" placeholder="Optional" value={reason} onChange={(e) => setReason(e.target.value)} data-attr="vendor-reply-reason" />
              </div>
            ) : null}
          </div>

          </div>
          <div className="flex justify-end border-t border-border/70 px-4 py-3" data-attr="vendor-bid-footer">
            <Button type="button" variant="primary" data-attr="vendor-reply-submit" loading={busy} onClick={() => submit()}>
              {active?.label ?? VENDOR_SERVICE_ACTION_LABEL.submitBid}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
