"use client";

/**
 * A shared-room lease's facts — the room and bed, the rent for that bed, and whether it is one joint
 * lease or one per resident — and, beside an uploaded PDF, the same terms as a "Shared room addendum".
 * A generated lease carries these clauses in its own text; a PDF is the manager's own document, so the
 * addendum is what arrives with it.
 */
import { BedDouble, FileText, Users, Wallet } from "lucide-react";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { sharedRoomClauses, type SharedRoomLeaseTerms } from "@/lib/lease-shared-room-terms";

export function LeaseSharedRoomFacts({ terms, addendum }: { terms: SharedRoomLeaseTerms; addendum: boolean }) {
  const me = terms.residents[0]!;
  return (
    <div className="space-y-3" data-sr-leasefacts data-attr="lease-shared-room-facts">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted">
        <PortalRowFact icon={BedDouble} srLabel="Bed">
          {`${terms.roomName} · ${me.bedLabel}`}
        </PortalRowFact>
        <PortalRowFact icon={Wallet} srLabel="Rent">
          {me.rentLabel.replace(" per month", "/mo")}
        </PortalRowFact>
        <PortalRowFact icon={terms.joint ? Users : FileText} srLabel="Lease">
          {terms.joint ? `Joint lease · ${terms.residents.length} residents` : "Individual lease"}
        </PortalRowFact>
      </div>
      {addendum ? (
        <section className="overflow-hidden rounded-2xl border border-border bg-card" data-attr="lease-shared-room-addendum" aria-label="Shared room addendum">
          <h3 className="border-b border-border/70 px-4 py-3 text-sm font-semibold text-foreground">Shared room addendum</h3>
          <div className="space-y-2.5 px-4 py-3 text-[13.5px] leading-relaxed text-foreground">
            {sharedRoomClauses(terms).map((c) => (
              <p key={c.id}>
                <strong>{c.title}.</strong> {c.body}
              </p>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
