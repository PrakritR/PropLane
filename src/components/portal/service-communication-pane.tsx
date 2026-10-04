"use client";

import { useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { RecordCommunicationSection } from "@/components/portal/record-communication-section";

export type ServiceCommunicationParty = { name: string; email?: string; phone?: string };

/**
 * A service's Communication tab, for add-on requests AND maintenance work: the full-page pane the
 * vendor record uses, with the service's counterparty (the resident) in the header. When a vendor is
 * also on the service, a "With" picker switches to that vendor's thread.
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
  const showPicker = Boolean(resident && vendor);
  return (
    <div className="flex min-h-[420px] flex-col px-3 pb-3 sm:px-4" data-attr="service-communication-pane">
      {showPicker ? (
        <div className="mb-3 max-w-xs">
          <FieldSingleSelect
            label="With"
            value={who}
            options={[
              { value: "resident", label: resident!.name },
              { value: "vendor", label: vendor!.name },
            ]}
            onChange={(next) => setWho(next === "vendor" ? "vendor" : "resident")}
            dataAttr="service-communication-with"
          />
        </div>
      ) : null}
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
  );
}
