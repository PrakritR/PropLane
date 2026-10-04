"use client";

import { useState } from "react";
import { RecordTabBand } from "@/components/portal/record-list-band";
import { RecordCommunicationSection } from "@/components/portal/record-communication-section";

export type ServiceCommunicationParty = { name: string; email?: string; phone?: string };

/**
 * A service's Communication tab, for add-on requests AND maintenance work: the full-page pane the
 * vendor record uses, with the service's counterparty (the resident) in the header. When a vendor is
 * also on the service, the band's tabs switch between the resident's and the vendor's thread. The
 * band sits above the thread like every other section.
 */
export function ServiceCommunicationPane({
  recordId,
  recordLabel,
  propertyId,
  resident,
  vendor,
}: {
  recordId: string;
  recordLabel: string;
  propertyId?: string;
  resident: ServiceCommunicationParty | null;
  vendor?: ServiceCommunicationParty | null;
}) {
  const [who, setWho] = useState<"resident" | "vendor">("resident");
  const party = who === "vendor" && vendor ? vendor : resident ?? vendor ?? null;
  return (
    <div className="flex min-h-[420px] flex-col" data-attr="service-communication-pane">
      <div data-attr="service-communication">
      <RecordTabBand
        dataAttr="service-communication"
        ariaLabel="Conversation"
        tabs={[
          ...(resident ? [{ id: "resident", label: resident.name }] : []),
          ...(vendor ? [{ id: "vendor", label: vendor.name }] : []),
        ]}
        activeId={who}
        onChange={(id) => setWho(id === "vendor" ? "vendor" : "resident")}
      />
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-3 sm:px-4">
        <RecordCommunicationSection
          key={who}
          fill
          role="manager"
          recordRef={{ kind: "service", id: recordId, label: recordLabel }}
          propertyId={propertyId}
          contactIds={party?.email?.trim() ? [party.email.trim()] : []}
          contactName={party?.name}
          contactPhone={party?.phone?.trim() || undefined}
        />
      </div>
    </div>
  );
}
