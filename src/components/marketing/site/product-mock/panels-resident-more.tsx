"use client";

/**
 * The resident sidebar's Tour and Documents tabs for the home demo, copied from the real pages
 * (`resident-tour-panel`: tabs Scheduled · Approved · Past, "Search tours", the round "Add tour"; and the
 * resident Documents page: To sign · Signed · Payments · Archived, "Search documents", Filter, "Add document").
 * Rows follow Jordan's story: his tour is Scheduled until the manager approves it, the lease is To sign once it is
 * sent and Signed after, rent paid leaves a receipt under Payments. Nothing saves or fetches.
 */

import { useMemo, useState } from "react";
import { CalendarDays, FileText, Filter, Home } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  RESIDENT_DOCUMENTS,
  RESIDENT_TOURS,
  type ResidentDocumentFixture,
  type ResidentTourFixture,
} from "@/components/marketing/site/product-mock/fixtures-more";
import { countBy, FixtureListScreen, FixtureMenuItems, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { FixtureField, FixtureSheet, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import { worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

/* ───────────────────────────── Tour ───────────────────────────── */

const TOUR_TABS = [
  { id: "scheduled", label: "Scheduled" },
  { id: "approved", label: "Approved" },
  { id: "past", label: "Past" },
];
const TOUR_EMPTY: Record<string, string> = { scheduled: "Nothing scheduled", approved: "Nothing approved", past: "Nothing past" };

export function ResidentTourPanel({ story }: { story?: DemoStory } = {}) {
  const { story: current } = worldFor(story);
  // Jordan's own tour: requested (Scheduled) until the manager confirms it (Approved).
  const tours: ResidentTourFixture[] = useMemo(
    () => RESIDENT_TOURS.filter((tour) => tour.id !== "rtour-willow" || current.tourOffered).map((tour) => (tour.id === "rtour-willow" && !current.tourAccepted ? { ...tour, bucket: "scheduled" as const } : tour)),
    [current],
  );
  const counts = useMemo(() => countBy(tours, (t) => t.bucket, TOUR_TABS.map((t) => t.id)), [tours]);
  const first = TOUR_TABS.find((t) => counts[t.id]! > 0)?.id ?? "scheduled";
  const [tab, setTab] = useState(first);
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const [selected, setSelected] = useState<ResidentTourFixture | null>(null);
  const rows = tours.filter((t) => t.bucket === tab && matchesSearch(search, t.property, t.place));

  return (
    <FixtureListScreen
      path="/resident/tour"
      title="Tour"
      tabs={TOUR_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={setTab}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search tours"
      primary={{ label: "Add tour", onClick: () => show("Add tour") }}
      isEmpty={rows.length === 0}
      emptyTitle={TOUR_EMPTY[tab]!}
      emptySection="tour"
      menu={<FixtureMenuItems toast={show} items={["Reschedule", "Message host", "Cancel tour"]} />}
      overlay={
        <>
          <FixtureSheet open={!!selected} title={selected?.property ?? ""} onClose={() => setSelected(null)}>
            {selected ? (
              <>
                <FixtureField label="Where" value={selected.place} />
                <FixtureField label="When" value={selected.when} />
              </>
            ) : null}
          </FixtureSheet>
          {toastNode}
        </>
      }
    >
      {rows.map((t) => (
        <PortalApplicantRecordRow
          key={t.id}
          name={t.property}
          tileIcon={Home}
          address={t.place}
          facts={<PortalRowFact icon={CalendarDays}>{t.when}</PortalRowFact>}
          omitActionView
          onSelectedChange={() => undefined}
          onOpen={() => setSelected(t)}
          dataAttr="resident-tour-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Documents ───────────────────────────── */

const DOCUMENT_TABS = [
  { id: "to-sign", label: "To sign" },
  { id: "signed", label: "Signed" },
  { id: "payments", label: "Payments" },
  { id: "archived", label: "Archived" },
];
const DOCUMENT_EMPTY: Record<string, string> = {
  "to-sign": "Nothing to sign right now.",
  signed: "Your signed lease will appear here once it's signed.",
  payments: "No rent receipts in this date range yet.",
  archived: "No documents yet",
};

export function ResidentDocumentsPanel({ story }: { story?: DemoStory } = {}) {
  const { story: current } = worldFor(story);
  const documents: ResidentDocumentFixture[] = useMemo(
    () =>
      RESIDENT_DOCUMENTS.filter((doc) => {
        if (doc.id === "rdoc-lease-sign") return current.leaseStep === 1;
        if (doc.id === "rdoc-lease-signed") return current.leaseStep >= 2;
        if (doc.id === "rdoc-receipt") return current.rentPaid;
        return current.applicationApproved;
      }),
    [current],
  );
  const counts = useMemo(() => countBy(documents, (d) => d.bucket, DOCUMENT_TABS.map((t) => t.id)), [documents]);
  const [tab, setTab] = useState<ResidentDocumentFixture["bucket"]>("to-sign");
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const rows = documents.filter((d) => d.bucket === tab && matchesSearch(search, d.title, d.meta));

  return (
    <FixtureListScreen
      path="/resident/documents/to-sign"
      title="Documents"
      tabs={DOCUMENT_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => setTab(id as ResidentDocumentFixture["bucket"])}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search documents"
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      primary={{ label: "Add document", onClick: () => show("Add document") }}
      isEmpty={rows.length === 0}
      emptyTitle={DOCUMENT_EMPTY[tab]!}
      emptySection="documents"
      menu={<FixtureMenuItems toast={show} items={["Open", "Download"]} />}
      overlay={toastNode}
    >
      {rows.map((d) => (
        <PortalApplicantRecordRow
          key={d.id}
          name={d.title}
          tileIcon={FileText}
          address={d.meta}
          omitActionView
          onSelectedChange={() => undefined}
          onOpen={() => show(`${d.title} (sample)`)}
          dataAttr="resident-document-row"
        />
      ))}
    </FixtureListScreen>
  );
}
