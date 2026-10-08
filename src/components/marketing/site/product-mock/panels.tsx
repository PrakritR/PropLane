"use client";

/**
 * The home page's product panels — captain 2026-09-26: "remove live demo no
 * need" + the Codex-style redesign. Each panel reuses the REAL portal
 * presentational components (`PortalRecordListSurface`, `PortalApplicantRecordRow`,
 * `ManagerPortalPageShell`, `PortalListControlStack`, `PortalIconAction`,
 * `PortalFilterSortSheet`, `KpiCard`, `AttentionPanel`, `UpcomingPanel`,
 * `PortfolioPropertiesSection`, `PortfolioImportReviewStep`) fed the static
 * fixtures in `fixtures.ts` — never a hand-drawn lookalike, never a network
 * request. Tabs and search filter the fixture rows client-side.
 *
 * Tours, Applications and Leases copy their real pages (captain 2026-10-08: "a lot of the pop ups in home page
 * are not accurate to real portal"): the real tab names, header icons, Filter popover and round +, the real
 * pop-ups behind them (`demo-popups-leasing.tsx`, loaded on demand), a row that opens its RECORD PAGE (rail,
 * header icons, section cards) and a ⋯ that carries that row's own actions. Saving, sending and approving only
 * close the pop-up and show a small "(sample)" toast — nothing persists, nothing fetches (see `shared.tsx`
 * and `docs/agents/marketing-mocks.md`).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bell, CalendarDays, CalendarPlus, Clock, Mail, Phone, Send, Settings, ShieldAlert, ShieldCheck, Share2, Users, Video } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import type { LeaseUpdatedWindow } from "@/components/portal/lease-filter-fields";
import { portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { AttentionPanel, KpiCard, UpcomingPanel } from "@/components/portal/pro-dashboard-kpis";
import { PortfolioPropertiesSection, type PortfolioPropertyCardData } from "@/components/portal/pro-dashboard-portfolio";
import { PortfolioImportReviewStep } from "@/components/portal/portfolio-import/review-step";
import { DEMO_IMPORT_SAMPLE } from "@/lib/demo/demo-import-sample";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { portalEmptyCopy, portalEmptyNoMatchTitle, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { MANAGER_TOUR_BUCKET_LABELS } from "@/lib/portal-detail-routes";
import { DEFAULT_PORTAL_LIST_GROUP_MODE, type PortalListGroupMode } from "@/lib/portal-list-grouping";
import {
  type ApplicationFixtureRow,
  type LeaseFixtureRow,
  type TourFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";
import {
  DemoAddApplicationPopup,
  DemoAddTourPopup,
  DemoApplicationRecord,
  DemoApplicationsFilter,
  DemoLeaseRecord,
  DemoLeasesFilter,
  DemoNotifyPopup,
  DemoSendLeasePopup,
  DemoShareLinkPopup,
  DemoTourAvailabilityPopup,
  DemoToursFilter,
  DemoTourRecord,
  prefetchLeasingPopups,
} from "@/components/marketing/site/product-mock/demo-popups-lazy-leasing";
import {
  LEASE_TAB_LABELS,
  LEASING_PROPERTIES,
  TOUR_NOTIFY_COPY,
  applicationTabOf,
  daysSinceStamp,
  isIncompleteApplication,
  placeProperty,
  tourNotifyMessage,
  type DemoApplicationTab,
  type TourNotifyAction,
} from "@/components/marketing/site/product-mock/fixtures-popups-leasing";
import { countBy, FixtureListScreen, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { useRowSelection } from "@/components/marketing/site/product-mock/row-selection";
import { DEMO_PAGE_CLASS, DemoTarget, PortalSidebarFixture, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import { worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

/** A panel mounted while the story is running keeps showing Jordan's row: when the
 * story moves his record to another tab, the panel follows it. */
function useFollow<T>(target: T | null, set: (value: T) => void) {
  useEffect(() => {
    if (target !== null) set(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
}

/**
 * Moves a manager makes on a row (confirm a tour, decline an application, delete a lease). A move only
 * applies while the row is still in the tab it left, so when the story moves the same row on its own
 * (Jordan's application, his lease) the story wins and no stale move lingers.
 */
function useBucketMoves<B extends string>() {
  const [moves, setMoves] = useState<Record<string, { from: B; to: B | "gone" }>>({});
  return {
    bucketOf: (id: string, base: B): B | "gone" => {
      const move = moves[id];
      return move && move.from === base ? move.to : base;
    },
    move: (id: string, from: B, to: B | "gone") => setMoves((prev) => ({ ...prev, [id]: { from, to } })),
  };
}

/** The record page's own frame: the same window, sidebar and page padding the list sits in. */
function RecordFrame({ path, sidebar, children, overlay }: { path: string; sidebar: ReactNode; children: ReactNode; overlay?: ReactNode }) {
  return (
    <ProductWindow path={path}>
      {sidebar}
      <div className={DEMO_PAGE_CLASS}>{children}</div>
      {overlay}
    </ProductWindow>
  );
}

/* ───────────────────────────── Tours ───────────────────────────── */

const TOUR_TAB_IDS = ["pending", "upcoming", "past"] as const;
type TourBucket = TourFixtureRow["bucket"];

type TourPopup =
  | { kind: "add" }
  | { kind: "availability" }
  | { kind: "share" }
  | { kind: "notify"; action: TourNotifyAction; row: TourFixtureRow };

/**
 * The real Tours page (`pro-tours.tsx`): Pending · Upcoming · Past, a Filter popover (Group by and Property), "Add
 * availability", "Share tour link" and the round +. A row opens the tour's record (Tour · Communication); its ⋯
 * is Message · Reschedule · Approve / Reject (pending) · Cancel tour (upcoming) · Delete.
 */
export function ToursPanel({ story }: { story?: DemoStory } = {}) {
  useEffect(() => prefetchLeasingPopups(), []);
  const world = worldFor(story);
  const jordan = world.story.tourOffered ? (world.story.tourAccepted ? "upcoming" : "pending") : null;
  const [bucket, setBucket] = useState<TourBucket>(jordan ?? "upcoming");
  useFollow<TourBucket>(jordan, setBucket);
  const [search, setSearch] = useState("");
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(DEFAULT_PORTAL_LIST_GROUP_MODE);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [added, setAdded] = useState<TourFixtureRow[]>([]);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [popup, setPopup] = useState<TourPopup | null>(null);
  const selection = useRowSelection();
  const moves = useBucketMoves<TourBucket>();
  const { show, node: toastNode } = useFixtureToast();

  const propertyOptions = useMemo(() => LEASING_PROPERTIES.map((p) => ({ id: p.id, label: p.label })), []);
  const rowsNow = useMemo(
    () =>
      [...added, ...world.tours].flatMap((row) => {
        const effective = moves.bucketOf(row.id, row.bucket);
        return effective === "gone" ? [] : [{ ...row, bucket: effective }];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [world, added, moves.bucketOf],
  );
  const counts = useMemo(() => countBy(rowsNow, (r) => r.bucket, [...TOUR_TAB_IDS]), [rowsNow]);
  const propertyTitles = propertyFilters.map((id) => propertyOptions.find((o) => o.id === id)?.label).filter(Boolean);
  const rows = useMemo(() => {
    const matching = rowsNow.filter(
      (r) =>
        r.bucket === bucket &&
        matchesSearch(search, r.guest, r.place, r.email) &&
        (propertyTitles.length === 0 || propertyTitles.includes(placeProperty(r.place))),
    );
    return groupMode === "house" ? [...matching].sort((a, b) => placeProperty(a.place).localeCompare(placeProperty(b.place))) : matching;
  }, [rowsNow, bucket, search, propertyTitles, groupMode]);
  const sidebar = <PortalSidebarFixture active="tours" counts={{ tours: counts.pending ?? 0 }} />;
  const recordRow = recordId ? (rowsNow.find((r) => r.id === recordId) ?? null) : null;
  const selectedRow = rowsNow.find((r) => r.id === selection.only);

  const notify = (action: TourNotifyAction, row: TourFixtureRow) => setPopup({ kind: "notify", action, row });
  const finishNotify = (action: TourNotifyAction, row: TourFixtureRow) => {
    if (action === "confirm") moves.move(row.id, row.bucket, "upcoming");
    else if (action === "decline" || action === "cancel") moves.move(row.id, row.bucket, "past");
    else if (action === "delete") moves.move(row.id, row.bucket, "gone");
    setPopup(null);
    setRecordId(null);
    selection.clear();
    show(TOUR_NOTIFY_COPY[action].done);
  };

  const popupNode =
    popup?.kind === "add" ? (
      <DemoAddTourPopup
        onClose={() => setPopup(null)}
        onAdded={(tour) => {
          setAdded((prev) => [{ ...tour, id: `tour-added-${prev.length + 1}`, bucket: "upcoming" }, ...prev]);
          setBucket("upcoming");
          setPopup(null);
          show("Tour scheduled (sample)");
        }}
      />
    ) : popup?.kind === "availability" ? (
      <DemoTourAvailabilityPopup onClose={() => setPopup(null)} />
    ) : popup?.kind === "share" ? (
      <DemoShareLinkPopup
        kind="tour"
        onClose={() => setPopup(null)}
        onToast={show}
        onSent={() => {
          setPopup(null);
          show("Tour link sent (sample)");
        }}
      />
    ) : popup?.kind === "notify" ? (
      <DemoNotifyPopup
        title={TOUR_NOTIFY_COPY[popup.action].title}
        recipient={popup.row.email}
        recipientPhone={popup.row.phone}
        {...tourNotifyMessage(popup.action, popup.row)}
        skipLabel={TOUR_NOTIFY_COPY[popup.action].skip}
        confirmLabel={TOUR_NOTIFY_COPY[popup.action].confirm}
        onClose={() => {
          setPopup(null);
          selection.clear();
        }}
        onConfirm={() => finishNotify(popup.action, popup.row)}
        onSkip={() => finishNotify(popup.action, popup.row)}
      />
    ) : null;

  if (recordRow) {
    return (
      <RecordFrame
        path={`/portal/tours/${recordRow.bucket}/${recordRow.id}`}
        sidebar={sidebar}
        overlay={
          <>
            {popupNode}
            {toastNode}
          </>
        }
      >
        <DemoTourRecord
          row={recordRow}
          onBack={() => setRecordId(null)}
          onAction={(id) => {
            if (id === "confirm") {
              moves.move(recordRow.id, recordRow.bucket, "upcoming");
              setRecordId(null);
              show("Tour confirmed (sample)");
            } else {
              notify(id, recordRow);
            }
          }}
        />
      </RecordFrame>
    );
  }

  const menuItems = (row: TourFixtureRow) => (
    <>
      <DropdownMenuItem onSelect={() => notify("message", row)}>Message</DropdownMenuItem>
      {row.bucket !== "past" ? <DropdownMenuItem onSelect={() => notify("reschedule", row)}>Reschedule</DropdownMenuItem> : null}
      {row.bucket === "pending" ? (
        <>
          <DropdownMenuItem onSelect={() => notify("confirm", row)}>Approve</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => notify("decline", row)}>Reject</DropdownMenuItem>
        </>
      ) : null}
      {row.bucket === "upcoming" ? <DropdownMenuItem onSelect={() => notify("cancel", row)}>Cancel tour</DropdownMenuItem> : null}
      <DropdownMenuItem onSelect={() => notify("delete", row)} className="text-danger">
        Delete
      </DropdownMenuItem>
    </>
  );

  return (
    <FixtureListScreen
      path="/portal/tours/upcoming"
      sidebar={sidebar}
      title="Tours"
      tabs={TOUR_TAB_IDS.map((id) => ({ id, label: MANAGER_TOUR_BUCKET_LABELS[id], count: counts[id], alert: id === "pending" && (counts[id] ?? 0) > 0 }))}
      activeId={bucket}
      onTab={(id) => {
        setBucket(id as TourBucket);
        selection.clear();
      }}
      tabAriaLabel="Tour status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search tours"
      actions={
        <>
          <DemoToursFilter
            groupMode={groupMode}
            onGroupModeChange={setGroupMode}
            propertyOptions={propertyOptions}
            propertyFilters={propertyFilters}
            onPropertyFiltersChange={setPropertyFilters}
          />
          <PortalIconAction icon={CalendarPlus} label="Add availability" data-attr="tours-add-availability-open" onClick={() => setPopup({ kind: "availability" })} />
          <PortalIconAction icon={Share2} label="Share tour link" data-attr="tours-share-open" onClick={() => setPopup({ kind: "share" })} />
        </>
      }
      primary={{ label: portalListAddPrimaryLabel("tour"), onClick: () => setPopup({ kind: "add" }) }}
      isEmpty={rows.length === 0}
      emptyTitle={
        search.trim() ? portalEmptyNoMatchTitle("tours", search) : propertyFilters.length > 0 ? portalEmptyNoMatchTitle("tours") : portalEmptyCopy(`tours.${bucket}` as PortalEmptyCopyKey).title
      }
      emptySection="tours"
      menu={selectedRow ? menuItems(selectedRow) : undefined}
      onBulkClear={selection.clear}
      overlay={
        <>
          {popupNode}
          {toastNode}
        </>
      }
    >
      {rows.map((row) => (
        <PortalApplicantRecordRow
          key={row.id}
          name={row.guest}
          address={row.place}
          facts={
            <>
              <PortalRowFact icon={CalendarDays} srLabel="When">
                {row.when}
              </PortalRowFact>
              {row.format === "virtual" ? (
                <PortalRowFact icon={Video} srLabel="Format">
                  Virtual
                </PortalRowFact>
              ) : null}
              <PortalRowFact icon={Mail} srLabel="Email">
                {row.email}
              </PortalRowFact>
              <PortalRowFact icon={Phone} srLabel="Phone">
                {row.phone}
              </PortalRowFact>
              {row.reminder ? (
                <PortalRowFact icon={Bell} srLabel="Reminders">
                  <span data-attr="tours-row-scheduled">{row.reminder}</span>
                </PortalRowFact>
              ) : null}
            </>
          }
          checked={selection.isChecked(row.id)}
          onSelectedChange={(checked) => selection.set(row.id, checked)}
          selectLabel={`${row.guest} · ${row.when}`}
          onOpen={() => setRecordId(row.id)}
          dataAttr="tour-list-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Applications ───────────────────────────── */

/** The real Applications tabs (pro-applications.tsx): Pending · Approved · Declined. */
const APPLICATION_TABS: { id: DemoApplicationTab; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Declined" },
];

type ApplicationPopup = { kind: "send" } | { kind: "add" };

/**
 * The real Applications page: Pending · Approved · Declined, a Filter popover (Property), "Send application link"
 * and the round +. A row opens the application's record (Application · Background check · Communication); its
 * ⋯ is Approve · Download · Move to pending · Decline · Delete (declined only).
 */
export function ApplicationsPanel({ story }: { story?: DemoStory } = {}) {
  useEffect(() => prefetchLeasingPopups(), []);
  const world = worldFor(story);
  const jordan = world.story.applicationSubmitted ? (world.story.applicationApproved ? "approved" : "pending") : null;
  const [bucket, setBucket] = useState<DemoApplicationTab>(jordan ?? "pending");
  useFollow<DemoApplicationTab>(jordan, setBucket);
  const [search, setSearch] = useState("");
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [added, setAdded] = useState<ApplicationFixtureRow[]>([]);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [popup, setPopup] = useState<ApplicationPopup | null>(null);
  const selection = useRowSelection();
  const moves = useBucketMoves<DemoApplicationTab>();
  const { show, node: toastNode } = useFixtureToast();

  const propertyOptions = useMemo(() => LEASING_PROPERTIES.map((p) => ({ id: p.id, label: p.label })), []);
  const propertyTitles = propertyFilters.map((id) => propertyOptions.find((o) => o.id === id)?.label).filter(Boolean);
  // The real page has no Incomplete tab (an unfinished application is a draft in Pending), and the sidebar badge counts
  // the submitted ones, so the demo's two drafts stay out of the list: Pending is the badge's count.
  const rowsNow = useMemo(
    () =>
      [...added, ...world.applications.filter((row) => !isIncompleteApplication(row))].flatMap((row) => {
        const effective = moves.bucketOf(row.id, applicationTabOf(row));
        return effective === "gone" ? [] : [{ row, tab: effective }];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [world, added, moves.bucketOf],
  );
  const visibleByFilter = rowsNow.filter(({ row }) => propertyTitles.length === 0 || propertyTitles.includes(row.property));
  const counts = useMemo(() => countBy(visibleByFilter, (r) => r.tab, APPLICATION_TABS.map((t) => t.id)), [visibleByFilter]);
  const rows = visibleByFilter.filter(({ row, tab }) => tab === bucket && matchesSearch(search, row.name, row.property, row.email));
  const sidebar = <PortalSidebarFixture active="applications" counts={{ applications: counts.pending ?? 0 }} />;
  const recordEntry = recordId ? (rowsNow.find(({ row }) => row.id === recordId) ?? null) : null;
  const selectedEntry = rowsNow.find(({ row }) => row.id === selection.only);

  const popupNode =
    popup?.kind === "send" ? (
      <DemoShareLinkPopup
        kind="apply"
        startAtReview
        onClose={() => setPopup(null)}
        onToast={show}
        onSent={() => {
          setPopup(null);
          show("Application link sent (sample)");
        }}
      />
    ) : popup?.kind === "add" ? (
      <DemoAddApplicationPopup
        onClose={() => setPopup(null)}
        onAdded={(application) => {
          setAdded((prev) => [
            { ...application, id: `app-added-${prev.length + 1}`, submitted: "Started Sep 26", stage: "Documents complete", bucket: "pending" },
            ...prev,
          ]);
          setBucket("pending");
          setPopup(null);
          show("Application added (sample)");
        }}
      />
    ) : null;

  /** One action on an application, from the record header or the row's ⋯. */
  const act = (id: string, row: ApplicationFixtureRow, tab: DemoApplicationTab) => {
    selection.clear();
    if (id === "approve") {
      moves.move(row.id, tab, "approved");
      setRecordId(null);
      show("Application approved (sample)");
    } else if (id === "reject") {
      moves.move(row.id, tab, "rejected");
      setRecordId(null);
      show("Application declined (sample)");
    } else if (id === "pending") {
      moves.move(row.id, tab, "pending");
      setRecordId(null);
      show("Moved to pending (sample)");
    } else if (id === "delete") {
      moves.move(row.id, tab, "gone");
      setRecordId(null);
      show("Application deleted (sample)");
    } else if (id === "download") {
      show("Download started (sample)");
    } else if (id === "upload-for-resident") {
      show("Upload for resident (sample)");
    } else if (id === "send-lease") {
      setRecordId(null);
      show("Send lease opens on the Leases tab (sample)");
    }
  };

  if (recordEntry) {
    return (
      <RecordFrame
        path={`/portal/applications/${recordEntry.tab}/${recordEntry.row.id}`}
        sidebar={sidebar}
        overlay={
          <>
            {popupNode}
            {toastNode}
          </>
        }
      >
        <DemoApplicationRecord
          row={{ ...recordEntry.row, bucket: recordEntry.tab }}
          onBack={() => setRecordId(null)}
          onAction={(id) => act(id, recordEntry.row, recordEntry.tab)}
        />
      </RecordFrame>
    );
  }

  const menuItems = (row: ApplicationFixtureRow, tab: DemoApplicationTab) => (
    <>
      {tab === "pending" ? <DropdownMenuItem onSelect={() => act("approve", row, tab)}>Approve</DropdownMenuItem> : null}
      <DropdownMenuItem onSelect={() => act("download", row, tab)}>Download</DropdownMenuItem>
      {tab !== "pending" ? <DropdownMenuItem onSelect={() => act("pending", row, tab)}>Move to pending</DropdownMenuItem> : null}
      {tab !== "rejected" ? (
        <DropdownMenuItem onSelect={() => act("reject", row, tab)} className="text-danger">
          Decline
        </DropdownMenuItem>
      ) : null}
      {tab === "rejected" ? (
        <DropdownMenuItem onSelect={() => act("delete", row, tab)} className="text-danger">
          Delete
        </DropdownMenuItem>
      ) : null}
    </>
  );

  return (
    <FixtureListScreen
      path="/portal/applications/pending"
      sidebar={sidebar}
      title="Applications"
      tabs={APPLICATION_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={bucket}
      onTab={(id) => {
        setBucket(id as DemoApplicationTab);
        selection.clear();
      }}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search applications"
      actions={
        <>
          <DemoApplicationsFilter propertyOptions={propertyOptions} propertyFilters={propertyFilters} onPropertyFiltersChange={setPropertyFilters} />
          <PortalIconAction icon={Send} label="Send application link" data-attr="applications-send" data-demo-target="applications-send" onClick={() => setPopup({ kind: "send" })} />
        </>
      }
      primary={{ label: portalListAddPrimaryLabel("application"), onClick: () => setPopup({ kind: "add" }) }}
      isEmpty={rows.length === 0}
      emptyTitle={
        search.trim()
          ? portalEmptyNoMatchTitle("applications", search)
          : propertyFilters.length > 0
            ? portalEmptyNoMatchTitle("applications")
            : portalEmptyCopy(`applications.${bucket}` as PortalEmptyCopyKey).title
      }
      emptySection="applications"
      menu={selectedEntry ? menuItems(selectedEntry.row, selectedEntry.tab) : undefined}
      onBulkClear={selection.clear}
      overlay={
        <>
          {popupNode}
          {toastNode}
        </>
      }
    >
      {rows.map(({ row, tab }) => (
        <DemoTarget id="application-row" key={row.id}>
          <PortalApplicantRecordRow
            name={row.name}
            address={`${row.property} · ${row.unit}`}
            facts={
              <>
                <PortalRowFact icon={Mail} srLabel="Email">
                  {row.email}
                </PortalRowFact>
                <PortalRowFact icon={CalendarDays} srLabel="Date">
                  {row.submitted}
                </PortalRowFact>
                {row.sharedFact ? (
                  <PortalRowFact icon={Users} srLabel="Resident">
                    {row.sharedFact}
                  </PortalRowFact>
                ) : null}
                {row.screening === "flagged" ? (
                  <PortalRowFact icon={ShieldAlert} srLabel="Screening">
                    Screening flagged
                  </PortalRowFact>
                ) : row.screening === "passed" ? (
                  <PortalRowFact icon={ShieldCheck} srLabel="Screening">
                    Screening passed
                  </PortalRowFact>
                ) : null}
              </>
            }
            checked={selection.isChecked(row.id)}
            onSelectedChange={(checked) => selection.set(row.id, checked)}
            selectLabel={row.name}
            onOpen={() => setRecordId(row.id)}
            dataAttr="application-list-row"
          />
        </DemoTarget>
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Leasing ───────────────────────────── */

type LeaseBucket = LeaseFixtureRow["bucket"];
const LEASE_EMPTY_KEY: Record<LeaseBucket, PortalEmptyCopyKey> = {
  manager: "leases.draft",
  resident: "leases.resident",
  signed: "leases.manager",
  completed: "leases.completed",
};

type LeasePopup = { kind: "send" } | { kind: "remind"; row: LeaseFixtureRow };

/**
 * The real Leases page: Draft · Resident signature · Manager signature · Signed, a Filter popover (Property,
 * Stage, Updated), the Lease settings gear (a Settings page in the real portal, a sample toast here) and the
 * round + that opens Send lease. A row opens the lease's record (Lease · Communication); its ⋯ is Send (drafts) ·
 * Download · Mark as signed · Delete.
 */
export function LeasesPanel({ story }: { story?: DemoStory } = {}) {
  useEffect(() => prefetchLeasingPopups(), []);
  const world = worldFor(story);
  const jordan = world.story.applicationApproved ? world.leases[0]!.bucket : null;
  const [bucket, setBucket] = useState<LeaseBucket>(jordan ?? "signed");
  useFollow<LeaseBucket>(jordan, setBucket);
  const [search, setSearch] = useState("");
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [stageFilters, setStageFilters] = useState<string[]>([]);
  const [updatedWindow, setUpdatedWindow] = useState<LeaseUpdatedWindow>("any");
  const [added, setAdded] = useState<LeaseFixtureRow[]>([]);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [popup, setPopup] = useState<LeasePopup | null>(null);
  const selection = useRowSelection();
  const moves = useBucketMoves<LeaseBucket>();
  const { show, node: toastNode } = useFixtureToast();

  const propertyOptions = useMemo(() => LEASING_PROPERTIES.map((p) => ({ id: p.id, label: p.label })), []);
  const propertyTitles = propertyFilters.map((id) => propertyOptions.find((o) => o.id === id)?.label).filter(Boolean);
  const allRows = useMemo(
    () =>
      [...added, ...world.leases].flatMap((row) => {
        const effective = moves.bucketOf(row.id, row.bucket);
        return effective === "gone" ? [] : [{ ...row, bucket: effective }];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [world, added, moves.bucketOf],
  );
  const stageOptions = useMemo(() => [...new Set(world.leases.map((l) => l.stage))].sort().map((value) => ({ value, label: value })), [world]);
  const windowDays = updatedWindow === "7d" ? 7 : updatedWindow === "30d" ? 30 : updatedWindow === "90d" ? 90 : null;
  const visibleByFilter = allRows.filter(
    (r) =>
      (propertyTitles.length === 0 || propertyTitles.includes(placeProperty(r.place))) &&
      (stageFilters.length === 0 || stageFilters.includes(r.stage)) &&
      (windowDays === null || daysSinceStamp(r.updated) <= windowDays),
  );
  const counts = useMemo(() => countBy(visibleByFilter, (r) => r.bucket, LEASE_TAB_LABELS.map((t) => t.id)), [visibleByFilter]);
  const rows = visibleByFilter.filter((r) => r.bucket === bucket && matchesSearch(search, r.resident, r.place, r.email, r.stage));
  const filtersActive = propertyFilters.length > 0 || stageFilters.length > 0 || updatedWindow !== "any";
  const sidebar = <PortalSidebarFixture active="leases" />;
  const recordRow = recordId ? (allRows.find((r) => r.id === recordId) ?? null) : null;
  const selectedRow = allRows.find((r) => r.id === selection.only);

  const act = (id: string, row: LeaseFixtureRow) => {
    selection.clear();
    if (id === "send") {
      moves.move(row.id, row.bucket, "resident");
      setRecordId(null);
      show("Lease sent for signature (sample)");
    } else if (id === "sign") {
      moves.move(row.id, row.bucket, "completed");
      setRecordId(null);
      show("Lease executed — deposit charge sent (sample)");
    } else if (id === "mark-signed") {
      moves.move(row.id, row.bucket, "completed");
      setRecordId(null);
      show("Lease marked as signed (sample)");
    } else if (id === "delete") {
      moves.move(row.id, row.bucket, "gone");
      setRecordId(null);
      show("Lease deleted (sample)");
    } else if (id === "remind") {
      setPopup({ kind: "remind", row });
    } else if (id === "download") {
      show("Download started (sample)");
    } else if (id === "edit") {
      show("Edit lease (sample)");
    }
  };

  const popupNode =
    popup?.kind === "send" ? (
      <DemoSendLeasePopup
        onClose={() => setPopup(null)}
        onSent={(candidate) => {
          setAdded((prev) => [
            { id: `lease-added-${prev.length + 1}`, resident: candidate.name, email: candidate.email, place: candidate.place, stage: "Resident signature pending", updated: "Sep 26", bucket: "resident" },
            ...prev,
          ]);
          setBucket("resident");
          setPopup(null);
          show("Lease sent for signature (sample)");
        }}
      />
    ) : popup?.kind === "remind" ? (
      <DemoNotifyPopup
        title="Lease signing reminder · preview"
        recipient={popup.row.email}
        subject={`Reminder: sign your lease for ${popup.row.place}`}
        body={`Hi ${popup.row.resident.split(/\s+/)[0]},\n\nYour lease for ${popup.row.place} is waiting for your signature. Open it from your PropLane account to review and sign.`}
        confirmLabel="Send reminder"
        onClose={() => {
          setPopup(null);
          selection.clear();
        }}
        onConfirm={() => {
          setPopup(null);
          selection.clear();
          show("Lease-signing reminder sent (sample)");
        }}
      />
    ) : null;

  if (recordRow) {
    return (
      <RecordFrame
        path={`/portal/leases/${recordRow.bucket}/${recordRow.id}`}
        sidebar={sidebar}
        overlay={
          <>
            {popupNode}
            {toastNode}
          </>
        }
      >
        <DemoLeaseRecord row={recordRow} onBack={() => setRecordId(null)} onAction={(id) => act(id, recordRow)} />
      </RecordFrame>
    );
  }

  const menuItems = (row: LeaseFixtureRow) => (
    <>
      {row.bucket === "manager" ? <DropdownMenuItem onSelect={() => act("send", row)}>Send</DropdownMenuItem> : null}
      <DropdownMenuItem onSelect={() => act("download", row)}>Download</DropdownMenuItem>
      {row.bucket !== "completed" ? <DropdownMenuItem onSelect={() => act("mark-signed", row)}>Mark as signed</DropdownMenuItem> : null}
      {row.bucket !== "completed" ? (
        <DropdownMenuItem onSelect={() => act("delete", row)} className="text-danger">
          Delete
        </DropdownMenuItem>
      ) : null}
    </>
  );

  return (
    <FixtureListScreen
      path="/portal/leases"
      sidebar={sidebar}
      title="Leases"
      tabs={LEASE_TAB_LABELS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={bucket}
      onTab={(id) => {
        setBucket(id as LeaseBucket);
        selection.clear();
      }}
      tabAriaLabel="Lease pipeline stage"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search leases"
      actions={
        <>
          <DemoLeasesFilter
            propertyOptions={propertyOptions}
            propertyFilters={propertyFilters}
            onPropertyFiltersChange={setPropertyFilters}
            stageOptions={stageOptions}
            stageFilters={stageFilters}
            onStageFiltersChange={setStageFilters}
            updatedWindow={updatedWindow}
            onUpdatedWindowChange={setUpdatedWindow}
          />
          <PortalIconAction icon={Settings} label="Lease settings" data-attr="leases-settings-open" onClick={() => show("Lease settings (sample)")} />
        </>
      }
      primary={{ label: portalListAddPrimaryLabel("lease"), onClick: () => setPopup({ kind: "send" }) }}
      isEmpty={rows.length === 0}
      emptyTitle={
        search.trim() ? portalEmptyNoMatchTitle("leases", search) : filtersActive ? portalEmptyNoMatchTitle("leases") : portalEmptyCopy(LEASE_EMPTY_KEY[bucket]).title
      }
      emptySection="leases"
      menu={selectedRow ? menuItems(selectedRow) : undefined}
      onBulkClear={selection.clear}
      overlay={
        <>
          {popupNode}
          {toastNode}
        </>
      }
    >
      {rows.map((row) => (
        <DemoTarget id="lease-row" key={row.id}>
          <PortalApplicantRecordRow
            name={row.resident}
            address={row.place}
            facts={
              <>
                <PortalRowFact icon={Mail} srLabel="Email">
                  {row.email}
                </PortalRowFact>
                <PortalRowFact icon={CalendarDays} srLabel="Stage">
                  {row.stage}
                </PortalRowFact>
                <PortalRowFact icon={Clock} srLabel="Last update">
                  Updated {row.updated}
                </PortalRowFact>
              </>
            }
            checked={selection.isChecked(row.id)}
            onSelectedChange={(checked) => selection.set(row.id, checked)}
            selectLabel={row.resident}
            onOpen={() => setRecordId(row.id)}
            dataAttr="lease-list-row"
          />
        </DemoTarget>
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Dashboard (hero) ───────────────────────────── */

export function DashboardPanel({ story }: { story?: DemoStory } = {}) {
  const [nowMs] = useState(() => Date.now());
  const { dashboard } = worldFor(story);
  const propertyCards: PortfolioPropertyCardData[] = dashboard.properties.map((p) => ({
    key: p.id,
    stage: "listed",
    title: p.title,
    address: p.address,
    spacesLabel: p.spacesLabel,
    spaces: Number(p.spacesLabel.split(" ")[0]) || 1,
    rentLabel: p.rentLabel,
    coverUrl: null,
  }));

  return (
    <ProductWindow path="/portal/dashboard" nativeHeight={900}>
      <PortalSidebarFixture active="dashboard" />
      <div className={DEMO_PAGE_CLASS}>
        <p className="mb-3 text-[15px] font-bold text-foreground">Welcome back</p>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="Occupancy" value={dashboard.occupancy.value} unit={dashboard.occupancy.unit} href="#" dataAttr="dashboard-metric-occupied" />
          <KpiCard label="Rent collected" value={dashboard.rentCollected.value} unit={dashboard.rentCollected.unit} href="#" dataAttr="dashboard-metric-collected" />
          <KpiCard label="Open requests" value={dashboard.openRequests.value} unit={dashboard.openRequests.unit} href="#" dataAttr="dashboard-metric-open-requests" />
          <KpiCard label="Applications ready" value={dashboard.applicationsReady.value} unit={dashboard.applicationsReady.unit} href="#" dataAttr="dashboard-metric-applications" />
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <AttentionPanel rows={dashboard.attention} />
          <UpcomingPanel rows={dashboard.upcoming} nowMs={nowMs} calendarHref="#" />
        </div>
        <PortfolioPropertiesSection cards={propertyCards} basePath="/portal" />
      </div>
    </ProductWindow>
  );
}

/* ───────────────────────────── Switching: import review ───────────────────────────── */

export function ImportReviewPanel({ nativeHeight = 760, whole = false }: { nativeHeight?: number; whole?: boolean } = {}) {
  const [proposal, setProposal] = useState(DEMO_IMPORT_SAMPLE);
  const { show, node: toastNode } = useFixtureToast();

  return (
    <ProductWindow path="/portal/properties/import" nativeWidth={1100} nativeHeight={nativeHeight} whole={whole}>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-card">
        <PortfolioImportReviewStep
          proposal={proposal}
          saving={false}
          onAnswer={(residentKey, patch) =>
            setProposal((prev) => ({
              ...prev,
              properties: prev.properties.map((property) => ({
                ...property,
                residents: property.residents.map((resident) => (resident.key === residentKey ? { ...resident, ...patch } : resident)),
              })),
            }))
          }
          onSkipToggle={() => show("Updated")}
          onContinue={() => show(`Created ${proposal.summary.residents}…`)}
        />
      </div>
      {toastNode}
    </ProductWindow>
  );
}

export { PaymentsPanel, ServicesPanel, CommunicationPanel } from "@/components/marketing/site/product-mock/panels-manager-money";
