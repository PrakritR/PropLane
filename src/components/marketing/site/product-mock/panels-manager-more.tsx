"use client";

/**
 * The manager Properties and Calendar tabs the home page's other panels do not draw, built from the same
 * real components the logged-in manager portal uses (`PortalPropertyRecordRow`, the calendar's own
 * `CalendarTimeGrid` / `CalendarMonthView` / `CalendarAgendaView`) and fed the one "Seattle Homes" world in
 * `fixtures.ts`. (Residents and Vendors live in `panels-manager-people.tsx`; the last line re-exports them.)
 *
 * What a click opens is what the real page opens, drawn in `demo-popups-home.tsx` and loaded on demand:
 *  - Properties: the round + is the New property wizard, the Share icon is "Send listing", a row is the
 *    property's record page, and the row's ⋯ is that row's own menu (View, Edit, Share, Duplicate, Unlist
 *    or Relist, Delete on a draft).
 *  - Calendar: the + is a menu (New tour, New task, New service, Add availability, the week tools, Connect
 *    Google Calendar) whose first four open the real pop-ups; an item on the grid is its tour / task / service
 *    record page; the view switch is the underline Day / Week / Month / Agenda tabs of the toolbar row.
 * Nothing saves or fetches: a primary only closes the pop-up and toasts "(sample)".
 *
 * Source of truth for tab names, header icons and row anatomy: `pro-house-properties-panel.tsx`,
 * `portal-calendar.tsx`, `portal-calendar-panels.tsx`.
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CircleOff, FileText, Home, Plug, Plus, Share2, TriangleAlert } from "lucide-react";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import {
  CalendarAgendaView,
  CalendarMonthView,
  CalendarTimeGrid,
  type CalendarGridItem,
} from "@/components/portal/manager-calendar-views";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CALENDAR_VIEW_TAB_LABELS } from "@/lib/portal-detail-routes";
import { type GridBand, type GridWindow } from "@/lib/calendar-grid";
import {
  CALENDAR_NOW_MIN,
  CALENDAR_TODAY,
  CALENDAR_WEEK,
  type CalendarFixtureItem,
  type PropertyFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";
import { countBy, FixtureListScreen, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { DemoFilterSheet } from "@/components/marketing/site/product-mock/demo-filter";
import { DEMO_PAGE_CLASS, PortalSidebarFixture, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import { useRowSelection } from "@/components/marketing/site/product-mock/row-selection";
import {
  DemoAddServicePopup,
  DemoAddTaskPopup,
  DemoAddTourPopup,
  DemoAvailabilityPopup,
  DemoCalendarFilterFields,
  DemoCalendarRecord,
  DemoNewPropertyPopup,
  DemoPropertyRecord,
  DemoShareListingPopup,
} from "@/components/marketing/site/product-mock/demo-popups-lazy-home";
import { HOME_EXTRA_PROPERTIES, homePropertyTitle } from "@/components/marketing/site/product-mock/fixtures-popups-home";
import { worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

/* ───────────────────────────── Properties ───────────────────────────── */

/** The real tabs (`MANAGER_STAGES` in `pro-house-properties-panel.tsx`): All, Listed, Unlisted, Drafts. */
const PROPERTY_TABS = [
  { id: "all", label: "All" },
  { id: "listed", label: "Listed" },
  { id: "unlisted", label: "Unlisted" },
  { id: "draft", label: "Drafts" },
];

/** The photo thumbnail's fallback — never a stock or invented photo (AGENTS.md). */
function PropertyTile() {
  return (
    <span className="flex h-[66px] w-[88px] shrink-0 items-center justify-center rounded-[10px] bg-accent/60 text-primary" aria-hidden>
      <Home className="size-[22px]" strokeWidth={1.5} />
    </span>
  );
}

type PropertyRow = PropertyFixtureRow & { attention?: string };

/**
 * The real Properties page: All · Listed · Unlisted · Drafts with counts, the Share listing link icon, the
 * round + (New property wizard), rows that open the property's record page, and a ⋯ that shows only what
 * applies to that row.
 */
export function PropertiesPanel({ story }: { story?: DemoStory } = {}) {
  const { properties: worldProperties } = worldFor(story);
  const PROPERTY_ROWS = useMemo<PropertyRow[]>(() => [...worldProperties, ...HOME_EXTRA_PROPERTIES], [worldProperties]);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const selection = useRowSelection();
  const [record, setRecord] = useState<PropertyRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PropertyRow | null>(null);
  const [sharing, setSharing] = useState<string[] | null>(null);
  const { show, node: toastNode } = useFixtureToast();

  const counts = useMemo(() => {
    const c = countBy(PROPERTY_ROWS, (r) => r.stage, ["listed", "unlisted", "draft"]);
    return { all: PROPERTY_ROWS.length, ...c };
  }, [PROPERTY_ROWS]);
  const rows = PROPERTY_ROWS.filter(
    (r) => (tab === "all" || r.stage === tab) && matchesSearch(search, homePropertyTitle(r), r.street, r.neighborhood),
  );
  const selectedRow = PROPERTY_ROWS.find((r) => r.id === selection.only);

  const overlays = (
    <>
      {creating ? (
        <DemoNewPropertyPopup
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            show("Property created (sample)");
          }}
        />
      ) : null}
      {editing ? (
        <DemoNewPropertyPopup
          editing={editing}
          onClose={() => setEditing(null)}
          onCreated={() => {
            setEditing(null);
            show("Property saved (sample)");
          }}
        />
      ) : null}
      {sharing ? (
        <DemoShareListingPopup
          properties={PROPERTY_ROWS}
          presetIds={sharing}
          onClose={() => setSharing(null)}
          onSent={() => {
            setSharing(null);
            show("Listing sent (sample)");
          }}
        />
      ) : null}
      {toastNode}
    </>
  );

  if (record) {
    return (
      <ProductWindow path={`/portal/properties/${record.stage === "draft" ? "drafts" : record.stage}/${record.id}`}>
        <PortalSidebarFixture active="properties" />
        <div className={DEMO_PAGE_CLASS}>
          <DemoPropertyRecord
            row={record}
            onBack={() => setRecord(null)}
            onEdit={() => setEditing(record)}
            onShare={() => setSharing([record.id])}
            onToast={show}
          />
        </div>
        {overlays}
      </ProductWindow>
    );
  }

  const rowMenu = (row: PropertyRow) => (
    <>
      <DropdownMenuItem onSelect={() => setRecord(row)}>Edit</DropdownMenuItem>
      {row.stage === "listed" ? <DropdownMenuItem onSelect={() => setSharing([row.id])}>Share</DropdownMenuItem> : null}
      <DropdownMenuItem onSelect={() => show("Property duplicated (sample)")}>Duplicate</DropdownMenuItem>
      {row.stage === "listed" ? <DropdownMenuItem onSelect={() => show("Unlisted (sample)")}>Unlist</DropdownMenuItem> : null}
      {row.stage === "unlisted" ? <DropdownMenuItem onSelect={() => show("Relisted (sample)")}>Relist</DropdownMenuItem> : null}
      {row.stage === "draft" ? (
        <DropdownMenuItem className="text-danger" onSelect={() => show("Draft deleted (sample)")}>
          Delete
        </DropdownMenuItem>
      ) : null}
    </>
  );

  return (
    <FixtureListScreen
      path="/portal/properties/all"
      sidebar={<PortalSidebarFixture active="properties" />}
      title="Properties"
      tabs={PROPERTY_TABS.map((t) => ({ ...t, count: counts[t.id as keyof typeof counts] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id);
        selection.clear();
      }}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search properties"
      actions={<PortalIconAction icon={Share2} label="Share listing link" onClick={() => setSharing([])} />}
      primary={{ label: "Add property", onClick: () => setCreating(true) }}
      isEmpty={rows.length === 0}
      emptyTitle="Nothing in Seattle Homes yet"
      emptySection="properties"
      menu={selectedRow ? rowMenu(selectedRow) : undefined}
      onBulkClear={selection.clear}
      overlay={overlays}
    >
      {rows.map((p) => {
        const draftFact = p.stage === "draft" && tab === "all";
        const facts =
          draftFact || p.stage === "unlisted" || p.attention ? (
            <>
              {draftFact ? (
                <PortalRowFact icon={FileText} srLabel="Stage">
                  Draft
                </PortalRowFact>
              ) : null}
              {p.stage === "unlisted" ? (
                <PortalRowFact icon={CircleOff} srLabel="Stage">
                  Off the market
                </PortalRowFact>
              ) : null}
              {p.attention ? (
                <PortalRowFact icon={TriangleAlert} srLabel="Needs you">
                  {p.attention}
                </PortalRowFact>
              ) : null}
            </>
          ) : undefined;
        return (
          <PortalPropertyRecordRow
            key={p.id}
            title={homePropertyTitle(p)}
            address={`${p.street} · ${p.neighborhood}`}
            meta={{ rooms: p.rooms }}
            facts={facts}
            leading={<PropertyTile />}
            checked={selection.isChecked(p.id)}
            onSelectedChange={(checked) => selection.set(p.id, checked)}
            onOpen={() => setRecord(p)}
            dataAttr="property-list-row"
          />
        );
      })}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Calendar ───────────────────────────── */

const CALENDAR_TABS = (["all", "tours", "services", "tasks"] as const).map((id) => ({ id, label: CALENDAR_VIEW_TAB_LABELS[id] }));
const KIND_BY_TAB: Record<string, CalendarFixtureItem["kind"] | null> = { all: null, tours: "tour", services: "service", tasks: "task" };

const VIEW_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "agenda", label: "Agenda" },
];

const GRID_WINDOW: GridWindow = { from: 8 * 60, to: 19 * 60, early: 0, late: 0 };

/** A fixture item as the calendar's own grid item. The grid reads the meeting
 * only for its source (a dashed "requested" tour) and the assignee line. */
function toGridItem(item: CalendarFixtureItem): CalendarGridItem {
  const meeting = {
    id: item.id,
    source: item.requested ? "inquiry" : "planned",
    sourceId: item.id,
    dateStr: item.dateStr,
    title: item.title,
    kind: item.kind,
    assigneeLabel: item.assignee,
  } as unknown as DemoMeeting;
  return {
    id: item.id,
    kind: item.kind,
    dateStr: item.dateStr,
    startMin: item.startMin,
    durationMin: item.durationMin,
    allDay: false,
    title: item.title,
    place: item.place,
    requested: Boolean(item.requested),
    person: null,
    meeting,
  };
}

type CalendarPopup = "tour" | "task" | "service" | "availability" | null;

const NAV_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-accent hover:text-foreground active:scale-95";

/**
 * The real Calendar page: All · Tours · Services · Tasks, Filter (Property), Integrations and the + menu in
 * the header; the Day · Week · Month · Agenda underline tabs at the left of the toolbar row and Today, the
 * chevrons and the range at the right; the real grid; and an item opens its record page.
 */
export function CalendarPanel({ story }: { story?: DemoStory } = {}) {
  const { calendar: CALENDAR_ITEMS, properties } = worldFor(story);
  const [tab, setTab] = useState("all");
  const [view, setView] = useState("week");
  const [search, setSearch] = useState("");
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [record, setRecord] = useState<CalendarFixtureItem | null>(null);
  const [popup, setPopup] = useState<CalendarPopup>(null);
  const { show, node: toastNode } = useFixtureToast();

  const propertyNames = useMemo(() => properties.map((p) => p.title), [properties]);
  const propertyOptions = useMemo(() => propertyNames.map((name) => ({ id: name, label: name })), [propertyNames]);

  const counts = useMemo(() => {
    const c = countBy(CALENDAR_ITEMS, (r) => r.kind, ["tour", "service", "task"]);
    return { all: CALENDAR_ITEMS.length, tours: c.tour, services: c.service, tasks: c.task };
  }, [CALENDAR_ITEMS]);

  const items = useMemo(() => {
    const kind = KIND_BY_TAB[tab];
    return CALENDAR_ITEMS.filter(
      (i) => (!kind || i.kind === kind) && (!propertyFilters.length || propertyFilters.includes(i.place)) && matchesSearch(search, i.title, i.place),
    ).map(toGridItem);
  }, [CALENDAR_ITEMS, tab, search, propertyFilters]);

  // Weekdays are open 9 to 5 by default; Saturday carries a typed tour window.
  const bandsByDate = useMemo(() => {
    const map = new Map<string, GridBand[]>();
    if (tab === "all" || tab === "tours") {
      CALENDAR_WEEK.forEach((ds, idx) => {
        if (idx < 5) map.set(ds, [{ startMin: 9 * 60, endMin: 17 * 60, kinds: ["tours"], source: "default" }]);
        else if (idx === 5) map.set(ds, [{ startMin: 12 * 60, endMin: 18 * 60, kinds: ["tours"], source: "typed" }]);
      });
    }
    return map;
  }, [tab]);

  const dates = view === "day" ? [CALENDAR_TODAY] : CALENDAR_WEEK;
  const open = (item: CalendarGridItem) => {
    const found = CALENDAR_ITEMS.find((i) => i.id === item.id);
    if (found) setRecord(found);
  };
  const noop = () => undefined;
  const rangeLabel = view === "day" ? "Thu, Sep 25" : view === "month" ? "September 2025" : "Sep 22 - Sep 28";
  const navUnit = view === "agenda" ? "week" : view;

  const overlays = (
    <>
      {popup === "tour" ? (
        <DemoAddTourPopup
          properties={propertyNames}
          onClose={() => setPopup(null)}
          onAdded={() => {
            setPopup(null);
            show("Tour added (sample)");
          }}
        />
      ) : null}
      {popup === "task" ? (
        <DemoAddTaskPopup
          properties={propertyNames}
          onClose={() => setPopup(null)}
          onAdded={() => {
            setPopup(null);
            show("Task added (sample)");
          }}
        />
      ) : null}
      {popup === "service" ? (
        <DemoAddServicePopup
          properties={propertyNames}
          onClose={() => setPopup(null)}
          onAdded={() => {
            setPopup(null);
            show("Service added (sample)");
          }}
        />
      ) : null}
      {popup === "availability" ? (
        <DemoAvailabilityPopup
          properties={propertyOptions}
          onClose={() => setPopup(null)}
          onSaved={() => {
            setPopup(null);
            show("Availability added (sample)");
          }}
        />
      ) : null}
      {toastNode}
    </>
  );

  if (record) {
    const section = record.kind === "tour" ? "tours" : record.kind === "task" ? "tasks" : "services";
    return (
      <ProductWindow path={`/portal/${section}/${record.id}`}>
        <PortalSidebarFixture active="calendar" />
        <div className={DEMO_PAGE_CLASS}>
          <DemoCalendarRecord item={record} onBack={() => setRecord(null)} onToast={show} />
        </div>
        {overlays}
      </ProductWindow>
    );
  }

  return (
    <FixtureListScreen
      path="/portal/calendar"
      sidebar={<PortalSidebarFixture active="calendar" />}
      title="Calendar"
      tabs={CALENDAR_TABS.map((t) => ({ ...t, count: counts[t.id as keyof typeof counts] }))}
      activeId={tab}
      onTab={setTab}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search calendar"
      actions={
        <>
          <DemoFilterSheet
            activeCount={propertyFilters.length ? 1 : 0}
            compactPanel
            commandStripTrigger
            dropdownAlign="start"
            filterFieldCount={1}
            mobileFlushBody
            onReset={() => setPropertyFilters([])}
            dataAttr="calendar-filter-sheet-open"
          >
            <DemoCalendarFilterFields
              propertyOptions={propertyOptions}
              propertyFilters={propertyFilters}
              onPropertyFiltersChange={setPropertyFilters}
              dataAttr="calendar-filter-property"
            />
          </DemoFilterSheet>
          <PortalIconAction icon={Plug} label="Integrations" data-attr="calendar-integrations" onClick={() => show("Integrations (sample)")} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <PortalPrimaryIconAction icon={Plus} label="Add" data-attr="calendar-create-menu" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-attr="calendar-create-menu-content">
              <DropdownMenuItem data-attr="calendar-create-tour" onSelect={() => setPopup("tour")}>
                New tour
              </DropdownMenuItem>
              <DropdownMenuItem data-attr="calendar-create-task" onSelect={() => setPopup("task")}>
                New task
              </DropdownMenuItem>
              <DropdownMenuItem data-attr="calendar-create-service" onSelect={() => setPopup("service")}>
                New service
              </DropdownMenuItem>
              <DropdownMenuItem data-attr="calendar-add-availability" onSelect={() => setPopup("availability")}>
                Add availability
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-attr="calendar-copy-previous-week" onSelect={() => show("Previous week copied (sample)")}>
                Copy previous week
              </DropdownMenuItem>
              <DropdownMenuItem data-attr="calendar-clear-week" onSelect={() => show("Week cleared (sample)")}>
                Clear week
              </DropdownMenuItem>
              <DropdownMenuItem data-attr="calendar-copy-to-houses" onSelect={() => show("Copied to houses (sample)")}>
                Copy to houses
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-attr="calendar-connect-google" onSelect={() => show("Connect Google Calendar (sample)")}>
                Connect Google Calendar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      isEmpty={false}
      emptyTitle=""
      menu={null}
      surface={false}
      overlay={overlays}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-1" data-attr="calendar-toolbar">
          <LocalDestinationNav
            appearance="command"
            ariaLabel="Calendar view"
            activeId={view}
            onChange={setView}
            items={VIEW_OPTIONS.map((option) => ({ id: option.value, label: option.label, dataAttr: `calendar-view-mode-${option.value}` }))}
            className="w-auto max-w-full"
          />
          <div className="flex min-w-0 items-center gap-1" data-attr="calendar-nav">
            <button
              type="button"
              className="h-7 shrink-0 rounded-md px-2 text-[13px] font-semibold text-muted transition hover:bg-accent hover:text-foreground"
              data-attr="calendar-today"
              onClick={() => show("Today (sample)")}
            >
              Today
            </button>
            <button type="button" className={NAV_BUTTON_CLASS} aria-label={`Previous ${navUnit}`} data-attr="calendar-nav-prev" onClick={() => show(`Previous ${navUnit} (sample)`)}>
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <span className="min-w-0 truncate whitespace-nowrap px-0.5 text-[13px] text-muted" data-attr="calendar-range-label">
              {rangeLabel}
            </span>
            <button type="button" className={NAV_BUTTON_CLASS} aria-label={`Next ${navUnit}`} data-attr="calendar-nav-next" onClick={() => show(`Next ${navUnit} (sample)`)}>
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        <div className="overflow-hidden rounded-[14px] border border-border bg-card">
          {view === "agenda" ? (
            <div className="p-3">
              <CalendarAgendaView dates={CALENDAR_WEEK} items={items} todayDs={CALENDAR_TODAY} onOpenItem={open} />
            </div>
          ) : view === "month" ? (
            <CalendarMonthView
              monthStart="2025-09-01"
              items={items}
              todayDs={CALENDAR_TODAY}
              phone={false}
              openHalfHoursFor={(ds) => (bandsByDate.has(ds) ? 16 : 0)}
              openLabel="Open for tours"
              onOpenItem={open}
              onOpenDay={() => setView("day")}
            />
          ) : (
            <CalendarTimeGrid
              dates={dates}
              items={items}
              bandsByDate={bandsByDate}
              window={GRID_WINDOW}
              expandEarly={false}
              expandLate={false}
              onToggleEarly={noop}
              onToggleLate={noop}
              todayDs={CALENDAR_TODAY}
              nowMin={CALENDAR_NOW_MIN}
              isDay={view === "day"}
              canEditAvailability={false}
              onOpenItem={open}
              onOpenDay={() => setView("day")}
              onBandClick={noop}
              onDragAdd={noop}
              minColumnPx={view === "day" ? 128 : 96}
            />
          )}
        </div>
      </div>
    </FixtureListScreen>
  );
}

export { ResidentsPanel, VendorsPanel } from "@/components/marketing/site/product-mock/panels-manager-people";
