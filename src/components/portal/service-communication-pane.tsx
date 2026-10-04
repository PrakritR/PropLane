"use client";

import { useMemo, useState } from "react";
import { RecordTabBand } from "@/components/portal/record-list-band";
import { RecordCommunicationSection } from "@/components/portal/record-communication-section";
import { serviceRecordIds, type ServiceCommunicationPartyTab } from "@/lib/service-communication-scope";

export type ServiceCommunicationParty = { name: string; email?: string; phone?: string };

/**
 * A service's Communication tab, for add-on requests AND maintenance work: one tab per party - the
 * resident first, then every vendor the job went to - and each tab shows ONLY this service's
 * conversation with that party (`serviceThreadsForParty`; the person-wide history lives on the main
 * Communication page, linked from the footer). An add-on's vendor conversations ride its linked vendor
 * job, so its scope is the add-on's id and the job's. The band sits above the thread like every other
 * section.
 */
export function ServiceCommunicationPane({
  recordId,
  linkedWorkOrderId,
  recordLabel,
  propertyId,
  parties: partiesProp,
  basePath = "/portal",
}: {
  recordId: string;
  /** An add-on's vendor job: its conversations belong to this service too. */
  linkedWorkOrderId?: string | null;
  recordLabel: string;
  propertyId?: string;
  parties: readonly ServiceCommunicationPartyTab[];
  basePath?: string;
}) {
  // Hosts build the list inline each render; keep one stable copy per content so the thread scope is stable.
  const partiesKey = JSON.stringify(partiesProp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parties = useMemo(() => partiesProp, [partiesKey]);
  const [activeId, setActiveId] = useState(parties[0]?.id ?? "resident");
  // A party that is no longer on the list (a request removed) falls back to the first tab.
  const party = parties.find((candidate) => candidate.id === activeId) ?? parties[0] ?? null;
  const recordIds = useMemo(() => serviceRecordIds(recordId, linkedWorkOrderId), [recordId, linkedWorkOrderId]);
  const scope = useMemo(
    () => ({ recordIds, party: party ? { email: party.email, phone: party.phone } : null }),
    [recordIds, party],
  );
  // A vendor is written to about the job that went to them; the resident about the service itself.
  const ref = {
    kind: "service" as const,
    id: party?.kind === "vendor" && linkedWorkOrderId ? linkedWorkOrderId : recordId,
    label: recordLabel,
  };
  return (
    <div className="flex min-h-[420px] flex-col" data-attr="service-communication-pane">
      <div data-attr="service-communication">
        <RecordTabBand
          dataAttr="service-communication"
          ariaLabel="Conversation"
          tabs={parties.map((candidate) => ({ id: candidate.id, label: candidate.name }))}
          activeId={party?.id ?? activeId}
          onChange={setActiveId}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-3 sm:px-4">
        <RecordCommunicationSection
          key={party?.id ?? "none"}
          fill
          role="manager"
          recordRef={ref}
          propertyId={propertyId}
          contactIds={party?.email?.trim() ? [party.email.trim()] : []}
          contactName={party?.name}
          contactPhone={party?.phone?.trim() || undefined}
          serviceScope={scope}
          fullConversationHref={`${basePath}/communication/active`}
        />
      </div>
    </div>
  );
}
