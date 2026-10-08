"use client";

import { useMemo, useState } from "react";
import { RecordTabBand } from "@/components/portal/record-list-band";
import { RecordCommunicationSection } from "@/components/portal/record-communication-section";
import { serviceRecordIds, type ServiceCommunicationPartyTab } from "@/lib/service-communication-scope";

export type ServiceCommunicationParty = { name: string; email?: string; phone?: string };

/** A vendor is written to about the job that went to them; the resident about the service itself. */
export function serviceRefForParty(
  party: Pick<ServiceCommunicationPartyTab, "kind">,
  service: { recordId: string; linkedWorkOrderId?: string | null; recordLabel: string },
) {
  return {
    kind: "service" as const,
    id: party.kind === "vendor" && service.linkedWorkOrderId ? service.linkedWorkOrderId : service.recordId,
    label: service.recordLabel,
  };
}

/** The id of the merged view's tab. */
export const SERVICE_EVERYONE_TAB_ID = "everyone";

/**
 * A service's Communication tab, for add-on requests AND maintenance work. It opens on "Everyone" (once the job
 * has more than one party): one time-ordered timeline of the resident's and every vendor's turns about this
 * service, each labeled with its author and party, and a "To" picker so a reply goes to exactly one party. After
 * it come the per-party tabs - the resident first, then every vendor the job went to - and each tab shows ONLY this service's
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
  const hasEveryone = parties.length > 1;
  const [activeId, setActiveId] = useState(hasEveryone ? SERVICE_EVERYONE_TAB_ID : (parties[0]?.id ?? "resident"));
  const everyoneActive = hasEveryone && activeId === SERVICE_EVERYONE_TAB_ID;
  // A party that is no longer on the list (a request removed) falls back to the first tab.
  const party = everyoneActive ? null : (parties.find((candidate) => candidate.id === activeId) ?? parties[0] ?? null);
  const recordIds = useMemo(() => serviceRecordIds(recordId, linkedWorkOrderId), [recordId, linkedWorkOrderId]);
  const everyone = useMemo(
    () => ({
      recordIds,
      parties,
      refs: Object.fromEntries(
        parties.map((candidate) => [candidate.id, serviceRefForParty(candidate, { recordId, linkedWorkOrderId, recordLabel })]),
      ),
    }),
    [recordIds, parties, linkedWorkOrderId, recordId, recordLabel],
  );
  const scope = useMemo(
    () => ({ recordIds, party: party ? { email: party.email, phone: party.phone } : null }),
    [recordIds, party],
  );
  const ref = party
    ? serviceRefForParty(party, { recordId, linkedWorkOrderId, recordLabel })
    : { kind: "service" as const, id: recordId, label: recordLabel };
  return (
    <div className="flex min-h-[420px] flex-col" data-attr="service-communication-pane">
      <div data-attr="service-communication">
        <RecordTabBand
          dataAttr="service-communication"
          ariaLabel="Conversation"
          tabs={[
            ...(hasEveryone ? [{ id: SERVICE_EVERYONE_TAB_ID, label: "Everyone" }] : []),
            ...parties.map((candidate) => ({ id: candidate.id, label: candidate.name })),
          ]}
          activeId={everyoneActive ? SERVICE_EVERYONE_TAB_ID : (party?.id ?? activeId)}
          onChange={setActiveId}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-3 sm:px-4">
        <RecordCommunicationSection
          key={everyoneActive ? SERVICE_EVERYONE_TAB_ID : (party?.id ?? "none")}
          fill
          role="manager"
          recordRef={ref}
          propertyId={propertyId}
          contactIds={party?.email?.trim() ? [party.email.trim()] : []}
          contactName={party?.name}
          contactPhone={party?.phone?.trim() || undefined}
          serviceScope={everyoneActive ? undefined : scope}
          serviceEveryone={everyoneActive ? everyone : undefined}
          fullConversationHref={`${basePath}/communication/active`}
        />
      </div>
    </div>
  );
}
