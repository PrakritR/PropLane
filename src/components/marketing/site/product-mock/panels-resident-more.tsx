"use client";

/**
 * The resident sidebar's Tour and Documents tabs for the home demo, copied from the real pages
 * (`resident-tour-panel`: tabs Scheduled · Approved · Past, "Search tours", the round "Add tour" that opens the
 * Schedule tour pop-up, rows with NO ⋯ that open the Tour page; and the resident Documents page: To sign · Signed ·
 * Payments · Archived, "Search documents", the Kind Filter, "Add document", rows that open the record their kind
 * opens). Rows follow Jordan's story: his tour is Scheduled until the manager approves it, the lease is To sign once
 * it is sent and Signed after, rent paid leaves a receipt under Payments. Nothing saves or fetches.
 */

import { useMemo, useState } from "react";
import { CalendarDays, FileText, Home } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { DemoFilterSheet, portalFilterActiveCount } from "@/components/marketing/site/product-mock/demo-filter";
import { portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import {
  RESIDENT_DOCUMENT_KIND_LABELS,
  RESIDENT_DOCUMENT_KIND_ORDER,
  RESIDENT_DOCUMENT_TAB_LABELS,
  RESIDENT_DOCUMENT_TAB_ORDER,
  type ResidentDocumentKind,
} from "@/lib/resident-documents-tabs";
import { RESIDENT_TOUR_SECTION_LABELS, RESIDENT_TOUR_SECTION_ORDER } from "@/lib/resident-tour-list";
import {
  RESIDENT_DOCUMENTS,
  RESIDENT_TOURS,
  type ResidentDocumentFixture,
  type ResidentTourFixture,
} from "@/components/marketing/site/product-mock/fixtures-more";
import { RESIDENT_HOME } from "@/components/marketing/site/product-mock/fixtures";
import { DEMO_OTHER_DOCUMENT } from "@/components/marketing/site/product-mock/fixtures-popups-resident";
import { countBy, FixtureListScreen, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { useRowSelection } from "@/components/marketing/site/product-mock/row-selection";
import { useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import { ResidentRecordFrame } from "@/components/marketing/site/product-mock/panels-resident";
import { PROPERTY_ROWS } from "@/components/marketing/site/product-mock/fixtures";
import { residentLeases, worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";
import {
  ResidentAddDocumentModal,
  ResidentApplicationRecord,
  ResidentConfirmModal,
  ResidentLeaseRecord,
  ResidentReceiptRecord,
  ResidentScheduleTour,
  ResidentTourRecord,
} from "@/components/marketing/site/product-mock/demo-popups-lazy-resident";

/* ───────────────────────────── Tour ───────────────────────────── */

const TOUR_TABS = RESIDENT_TOUR_SECTION_ORDER.map((id) => ({ id, label: RESIDENT_TOUR_SECTION_LABELS[id] }));
const TOUR_EMPTY: Record<string, string> = { scheduled: "Nothing scheduled", approved: "Nothing approved", past: "Nothing past" };

export function ResidentTourPanel({ story }: { story?: DemoStory } = {}) {
  const { story: current } = worldFor(story);
  // Jordan's own tour: requested (Scheduled) until the manager confirms it (Approved).
  const tours: ResidentTourFixture[] = useMemo(
    () => RESIDENT_TOURS.filter((tour) => tour.id !== "rtour-willow" || current.tourOffered).map((tour) => (tour.id === "rtour-willow" && !current.tourAccepted ? { ...tour, bucket: "scheduled" as const } : tour)),
    [current],
  );
  const [cancelledIds, setCancelledIds] = useState<string[]>([]);
  const live = useMemo(() => tours.filter((t) => !cancelledIds.includes(t.id)), [tours, cancelledIds]);
  const counts = useMemo(() => countBy(live, (t) => t.bucket, TOUR_TABS.map((t) => t.id)), [live]);
  const first = TOUR_TABS.find((t) => counts[t.id]! > 0)?.id ?? "scheduled";
  const [tab, setTab] = useState(first);
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const [scheduling, setScheduling] = useState<{ propertyId: string | null } | null>(null);
  const [record, setRecord] = useState<ResidentTourFixture | null>(null);
  const rows = live.filter((t) => t.bucket === tab && matchesSearch(search, t.property, t.place));

  const scheduleModal = scheduling ? (
    <ResidentScheduleTour
      initialPropertyId={scheduling.propertyId}
      onClose={() => setScheduling(null)}
      onScheduled={() => {
        setScheduling(null);
        show("Tour request sent (sample)");
      }}
    />
  ) : null;

  if (record) {
    return (
      <ResidentRecordFrame path={`/resident/tour/${record.bucket}/${record.id}`} toast={toastNode}>
        <ResidentTourRecord
          tour={record}
          onBack={() => setRecord(null)}
          onToast={show}
          onReschedule={() => setScheduling({ propertyId: PROPERTY_ROWS.find((p) => p.title === record.property)?.id ?? null })}
          onCancelled={() => {
            setCancelledIds((ids) => [...ids, record.id]);
            setRecord(null);
            show("Tour cancelled (sample)");
          }}
        />
        {scheduleModal}
      </ResidentRecordFrame>
    );
  }

  return (
    <FixtureListScreen
      path="/resident/tour"
      title="Tour"
      tabs={TOUR_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => setTab(id as typeof tab)}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search tours"
      primary={{ label: portalListAddPrimaryLabel("tour"), onClick: () => setScheduling({ propertyId: null }) }}
      isEmpty={rows.length === 0}
      emptyTitle={TOUR_EMPTY[tab]!}
      emptySection="tour"
      overlay={
        <>
          {scheduleModal}
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
          onOpen={() => setRecord(t)}
          dataAttr="resident-tour-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Documents ───────────────────────────── */

const DOCUMENT_TABS = RESIDENT_DOCUMENT_TAB_ORDER.map((id) => ({ id, label: RESIDENT_DOCUMENT_TAB_LABELS[id] }));
const DOCUMENT_EMPTY: Record<string, string> = {
  "to-sign": "Nothing to sign right now.",
  signed: "Your signed lease will appear here once it's signed.",
  payments: "No rent receipts in this date range yet.",
  archived: "No documents yet",
};

type DocRow = ResidentDocumentFixture & { kind: ResidentDocumentKind };

const KIND_BY_ID: Record<string, ResidentDocumentKind> = {
  "rdoc-lease-sign": "lease",
  "rdoc-lease-signed": "lease",
  "rdoc-receipt": "receipts",
  "rdoc-app": "application",
  "rdoc-insurance": "other",
};

export function ResidentDocumentsPanel({ story }: { story?: DemoStory } = {}) {
  const { story: current } = worldFor(story);
  const leases = residentLeases(current);
  const [added, setAdded] = useState<DocRow[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const documents: DocRow[] = useMemo(
    () =>
      [
        ...RESIDENT_DOCUMENTS.filter((doc) => {
          if (doc.id === "rdoc-lease-sign") return current.leaseStep === 1;
          if (doc.id === "rdoc-lease-signed") return current.leaseStep >= 2;
          if (doc.id === "rdoc-receipt") return current.rentPaid;
          return current.applicationApproved;
        }),
        ...(current.applicationApproved ? [DEMO_OTHER_DOCUMENT] : []),
      ]
        .map((doc) => ({ ...doc, kind: KIND_BY_ID[doc.id] ?? "other" }))
        .concat(added)
        .filter((doc) => !removedIds.includes(doc.id)),
    [current, added, removedIds],
  );
  const [kind, setKind] = useState<ResidentDocumentKind | "all">("all");
  const [from, setFrom] = useState("2025-01-01");
  const [to, setTo] = useState("2025-12-31");
  const [tab, setTab] = useState<ResidentDocumentFixture["bucket"]>("to-sign");
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [adding, setAdding] = useState(false);
  const [record, setRecord] = useState<DocRow | null>(null);
  const [removing, setRemoving] = useState<DocRow | null>(null);
  const inKind = documents.filter((d) => kind === "all" || d.kind === kind);
  const counts = useMemo(() => countBy(inKind, (d) => d.bucket, DOCUMENT_TABS.map((t) => t.id)), [inKind]);
  const rows = inKind.filter((d) => d.bucket === tab && matchesSearch(search, d.title, d.meta));
  const selected = documents.find((d) => d.id === selection.only);
  const showReceiptRange = (tab === "payments" || tab === "archived") && (kind === "all" || kind === "receipts");

  const menuFor = (doc: DocRow) => (
    <>
      {doc.kind === "lease" || doc.kind === "other" ? <DropdownMenuItem onSelect={() => open(doc)}>Open</DropdownMenuItem> : null}
      <DropdownMenuItem onSelect={() => show("Download (sample)")}>Download</DropdownMenuItem>
      {doc.kind === "other" ? <DropdownMenuItem onSelect={() => setRemoving(doc)}>Remove</DropdownMenuItem> : null}
    </>
  );

  // Row click depends on the kind: an application, a lease and a receipt open their own page; another file opens itself.
  function open(doc: DocRow) {
    if (doc.kind === "other") {
      show(`Opening ${doc.title} (sample)`);
      return;
    }
    setRecord(doc);
  }

  const modals = (
    <>
      {adding ? (
        <ResidentAddDocumentModal
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setAdded((list) => [...list, { id: `rdoc-added-${list.length + 1}`, title: "New document", meta: "Uploaded just now", bucket: "archived", kind: "other" }]);
            show("Added to Other documents (sample)");
          }}
        />
      ) : null}
      {removing ? (
        <ResidentConfirmModal
          title="Remove document"
          description={`Remove “${removing.title}” from your documents?`}
          confirmLabel="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            setRemovedIds((ids) => [...ids, removing.id]);
            setRemoving(null);
            selection.clear();
            show("Removed (sample)");
          }}
        />
      ) : null}
    </>
  );

  if (record) {
    const lease = leases[0] ?? { id: "lease-jordan", bucket: "signed" as const, label: "Signed", managerSigned: true };
    const application = {
      id: "app-jordan",
      property: RESIDENT_HOME.property,
      unit: RESIDENT_HOME.room,
      submitted: "Sep 22",
      stage: "Approved",
      bucket: "approved" as const,
    };
    return (
      <ResidentRecordFrame path={`/resident/documents/${record.kind}/${record.id}`} toast={toastNode}>
        {record.kind === "application" ? (
          <ResidentApplicationRecord
            application={application}
            title="Rental application"
            backLabel="Back to documents"
            onBack={() => setRecord(null)}
            onToast={show}
            onWithdrawn={() => setRecord(null)}
          />
        ) : record.kind === "lease" ? (
          <ResidentLeaseRecord lease={lease} initialSection="lease-document" backLabel="Back to documents" onBack={() => setRecord(null)} onToast={show} />
        ) : (
          <ResidentReceiptRecord onBack={() => setRecord(null)} onToast={show} />
        )}
      </ResidentRecordFrame>
    );
  }

  return (
    <FixtureListScreen
      path="/resident/documents/to-sign"
      title="Documents"
      tabs={DOCUMENT_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id as ResidentDocumentFixture["bucket"]);
        selection.clear();
      }}
      tabAriaLabel="Documents"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search documents"
      actions={
        <div className="flex items-center gap-1.5">
          <DemoFilterSheet
            activeCount={portalFilterActiveCount([kind !== "all" ? kind : ""])}
            compactPanel
            commandStripTrigger
            filterFieldCount={1}
            onReset={() => setKind("all")}
            dataAttr="resident-documents-kind-filter-open"
          >
            <FieldSingleSelect
              label="Kind"
              variant="cell"
              value={kind}
              onChange={(next) => setKind(next as ResidentDocumentKind | "all")}
              options={[{ value: "all", label: "All kinds" }, ...RESIDENT_DOCUMENT_KIND_ORDER.map((k) => ({ value: k, label: RESIDENT_DOCUMENT_KIND_LABELS[k] }))]}
              dataAttr="resident-documents-kind-select"
            />
          </DemoFilterSheet>
          {showReceiptRange ? (
            <DemoFilterSheet
              activeCount={0}
              compactPanel
              commandStripTrigger
              filterFieldCount={2}
              mobileFlushBody
              onReset={() => {
                setFrom("2025-01-01");
                setTo("2025-12-31");
              }}
              dataAttr="resident-documents-receipt-filter-open"
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted">
                  From
                  <Input type="date" className="h-10 w-full min-w-0 portal-modal-date-input" value={from} onChange={(e) => setFrom(e.target.value)} data-attr="resident-documents-receipt-from" />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted">
                  To
                  <Input type="date" className="h-10 w-full min-w-0 portal-modal-date-input" value={to} onChange={(e) => setTo(e.target.value)} data-attr="resident-documents-receipt-to" />
                </label>
              </div>
            </DemoFilterSheet>
          ) : null}
        </div>
      }
      primary={{ label: portalListAddPrimaryLabel("document"), onClick: () => setAdding(true) }}
      isEmpty={rows.length === 0}
      emptyTitle={DOCUMENT_EMPTY[tab]!}
      emptySection="documents"
      menu={selected ? menuFor(selected) : undefined}
      onBulkClear={selection.clear}
      overlay={
        <>
          {modals}
          {toastNode}
        </>
      }
    >
      {rows.map((d) => (
        <PortalApplicantRecordRow
          key={d.id}
          name={d.title}
          tileIcon={FileText}
          address={d.meta}
          omitActionView
          checked={selection.isChecked(d.id)}
          onSelectedChange={(checked) => selection.set(d.id, checked)}
          onOpen={() => open(d)}
          dataAttr="resident-document-row"
        />
      ))}
    </FixtureListScreen>
  );
}

