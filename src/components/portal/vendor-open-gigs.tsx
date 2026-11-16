"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, MapPin, Sparkles } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";

type Gig = { code: string; kind: string; area: string; when: string; pays: string };

/**
 * "Open jobs near you" (PropLane Jobs): the priced jobs a landlord posted (a tour showing, a cleaning, an odd job) that this
 * vendor's trade and service area cover. A vendor sees the kind, the general area, the time and the pay, never the address.
 * Take it files the same submitted bid at the offered price a YES text does (`POST /api/vendor/gigs`); the landlord then
 * approves one. Draws nothing when there is none.
 */
export function VendorOpenGigs() {
  const { showToast } = useAppUi();
  const [gigs, setGigs] = useState<Gig[]>([]);
  const [busyCode, setBusyCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/vendor/gigs", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { gigs?: Gig[] };
      setGigs(Array.isArray(body.gigs) ? body.gigs : []);
    } catch {
      /* the list stays as it was */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const answer = async (gig: Gig, action: "accept" | "decline") => {
    if (busyCode) return;
    setBusyCode(gig.code);
    try {
      const res = await fetch("/api/vendor/gigs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: gig.code, action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? "Could not save your answer.");
      } else {
        showToast(action === "accept" ? "Sent. The landlord will confirm." : "Passed.");
      }
    } catch {
      showToast("Could not save your answer.");
    } finally {
      setBusyCode(null);
      await load();
    }
  };

  if (gigs.length === 0) return null;

  return (
    <div className="mb-3" data-attr="vendor-open-gigs">
      <PortalRecordListSurface isEmpty={false} dataAttr="vendor-open-gigs-list">
        {gigs.map((gig) => (
          <PortalApplicantRecordRow
            key={gig.code}
            name={gig.kind}
            tileIcon={Sparkles}
            address={gig.area}
            facts={
              <>
                <PortalRowFact icon={MapPin} srLabel="Area">
                  {gig.area}
                </PortalRowFact>
                {gig.when ? (
                  <PortalRowFact icon={Clock} srLabel="When">
                    {gig.when}
                  </PortalRowFact>
                ) : null}
              </>
            }
            amount={gig.pays}
            dataAttr="vendor-open-gig-row"
            actions={
              <div className="flex items-center gap-2">
                <Button type="button" variant="primary" disabled={busyCode !== null} onClick={() => answer(gig, "accept")} data-attr="vendor-open-gig-take">
                  Take it
                </Button>
                <Button type="button" variant="ghost" disabled={busyCode !== null} onClick={() => answer(gig, "decline")} data-attr="vendor-open-gig-pass">
                  Pass
                </Button>
              </div>
            }
          />
        ))}
      </PortalRecordListSurface>
    </div>
  );
}
