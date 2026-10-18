"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, DollarSign, Siren, Zap } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { formatServiceWhen } from "@/lib/service-lifecycle";
import { formatRulePay, DISPATCH_URGENCY_LABEL } from "@/lib/vendor-dispatch/rules";
import type { VendorDispatchOffer } from "@/lib/vendor-dispatch/runs-view";
import type { DispatchUrgency } from "@/lib/vendor-dispatch/trades";

/**
 * Open dispatch offers in the vendor portal (vendor-dispatch-1018). The vendor
 * sees only their own offered attempts, with the general area (what the offer
 * text carries) until they accept. Accept and decline land in the same state
 * the SMS reply does (`POST /api/vendor/dispatch-offers/[attemptId]`).
 * Draws nothing when there is no offer.
 */
export function VendorDispatchOffers() {
  const { showToast } = useAppUi();
  const [offers, setOffers] = useState<VendorDispatchOffer[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/vendor/dispatch-offers", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { offers?: VendorDispatchOffer[] };
      setOffers(Array.isArray(body.offers) ? body.offers : []);
    } catch {
      /* the list stays as it was */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const answer = async (offer: VendorDispatchOffer, choice: "accept" | "decline") => {
    if (busyId) return;
    setBusyId(offer.attemptId);
    try {
      const res = await fetch(`/api/vendor/dispatch-offers/${encodeURIComponent(offer.attemptId)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: choice }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? "Could not save your answer.");
      } else {
        showToast(choice === "accept" ? "You took the job." : "Declined.");
      }
    } catch {
      showToast("Could not save your answer.");
    } finally {
      setBusyId(null);
      await load();
    }
  };

  if (offers.length === 0) return null;

  return (
    <div className="mb-3" data-attr="vendor-dispatch-offers">
      <PortalRecordListSurface isEmpty={false} dataAttr="vendor-dispatch-offers-list">
        {offers.map((offer) => {
          const title = offer.issueLabel ? `${offer.tradeLabel} · ${offer.issueLabel}` : offer.tradeLabel;
          const urgencyLabel = DISPATCH_URGENCY_LABEL[offer.urgency as DispatchUrgency];
          const open = offer.status === "offered";
          return (
            <PortalApplicantRecordRow
              key={offer.attemptId}
              name={title}
              tileIcon={offer.urgency === "emergency" ? Siren : Zap}
              address={offer.offerText}
              facts={
                <>
                  {urgencyLabel ? (
                    <PortalRowFact icon={Zap} srLabel="Urgency">
                      {urgencyLabel}
                    </PortalRowFact>
                  ) : null}
                  {offer.answerBy ? (
                    <PortalRowFact icon={Clock} srLabel="Answer by">
                      {formatServiceWhen(offer.answerBy)}
                    </PortalRowFact>
                  ) : null}
                  {!open ? (
                    <PortalRowFact icon={DollarSign} srLabel="Status">
                      You took this job
                    </PortalRowFact>
                  ) : null}
                </>
              }
              amount={formatRulePay(offer.payCents, offer.payCents == null ? "quote" : "flat")}
              dataAttr="vendor-dispatch-offer-row"
              actions={
                open ? (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={busyId !== null}
                      onClick={() => answer(offer, "accept")}
                      data-attr="vendor-dispatch-accept"
                    >
                      Accept
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busyId !== null}
                      onClick={() => answer(offer, "decline")}
                      data-attr="vendor-dispatch-decline"
                    >
                      Decline
                    </Button>
                  </div>
                ) : undefined
              }
            />
          );
        })}
      </PortalRecordListSurface>
    </div>
  );
}
