"use client";

/**
 * The four manager tabs the home page's other panels do not draw —
 * Properties, Residents, Calendar and Vendors — built from the same real
 * components the logged-in manager portal uses (`PortalPropertyRecordRow`,
 * `PortalApplicantRecordRow`, the calendar's own `CalendarTimeGrid` /
 * `CalendarMonthView` / `CalendarAgendaView`) and fed the one "Seattle Homes"
 * world in `fixtures.ts`. Static: tabs, search and the view switch work, the
 * ⋯ menus open, and nothing saves or fetches.
 *
 * Source of truth for tab names, header icons and row anatomy:
 * `pro-properties.tsx`, `pro-residents.tsx`, `portal-calendar.tsx`,
 * `pro-vendors-panel.tsx`.
 */

import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  Filter,
  Home,
  Mail,
  MapPin,
  Phone,
  Settings,
  Share2,
  ShieldCheck,
  Star,
  TriangleAlert,
  UserRound,
  Users,
  Wrench,
} from "lucide-react";
import { PortalApplicantRecordRow, PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  CalendarAgendaView,
  CalendarMonthView,
  CalendarTimeGrid,
  type CalendarGridItem,
} from "@/components/portal/manager-calendar-views";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { type GridBand, type GridWindow } from "@/lib/calendar-grid";
import {
  CALENDAR_NOW_MIN,
  CALENDAR_TODAY,
  CALENDAR_WEEK,
  CATALOG_VENDORS,
  type CalendarFixtureItem,
  type PropertyFixtureRow,
  type ResidentFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";
import { countBy, FixtureListScreen, FixtureMenuItems, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { FixtureField, FixtureSheet, PortalSidebarFixture, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import { worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

/* ───────────────────────────── Properties ───────────────────────────── */

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

export function PropertiesPanel({ story }: { story?: DemoStory } = {}) {
  const { properties: PROPERTY_ROWS } = worldFor(story);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PropertyFixtureRow | null>(null);
  const { show, node: toastNode } = useFixtureToast();

  const counts = useMemo(() => {
    const c = countBy(PROPERTY_ROWS, (r) => r.stage, ["listed", "unlisted", "draft"]);
    return { all: PROPERTY_ROWS.length, ...c };
  }, [PROPERTY_ROWS]);
  const rows = PROPERTY_ROWS.filter((r) => (tab === "all" || r.stage === tab) && matchesSearch(search, r.title, r.street, r.neighborhood));

  return (
    <FixtureListScreen
      path="/portal/properties/all"
      sidebar={<PortalSidebarFixture active="properties" />}
      title="Properties"
      tabs={PROPERTY_TABS.map((t) => ({ ...t, count: counts[t.id as keyof typeof counts] }))}
      activeId={tab}
      onTab={setTab}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search properties"
      actions={<PortalIconAction icon={Share2} label="Share listing link" onClick={() => show("Listing link copied")} />}
      primary={{ label: "Add property", onClick: () => show("Add property") }}
      isEmpty={rows.length === 0}
      emptyTitle="Nothing in Seattle Homes yet"
      emptySection="properties"
      menu={<FixtureMenuItems toast={show} items={["Edit", "Share", "Duplicate", "Unlist"]} />}
      overlay={
        <>
          <FixtureSheet open={!!selected} title={selected?.title ?? ""} onClose={() => setSelected(null)} primaryLabel="Edit" onPrimary={() => { show("Property saved (sample)"); setSelected(null); }}>
            {selected ? (
              <>
                <FixtureField label="Address" value={`${selected.street} · ${selected.neighborhood}`} />
                <FixtureField label="Rooms" value={`${selected.rooms} ${selected.rooms === 1 ? "room" : "rooms"}`} />
                <FixtureField label="Listing" value={selected.stage === "listed" ? "Listed" : selected.stage === "unlisted" ? "Off the market" : "Draft"} />
              </>
            ) : null}
          </FixtureSheet>
          {toastNode}
        </>
      }
    >
      {rows.map((p) => (
        <PortalPropertyRecordRow
          key={p.id}
          title={p.title}
          address={`${p.street} · ${p.neighborhood}`}
          meta={{ rooms: p.rooms }}
          facts={p.attention ? <PortalRowFact icon={TriangleAlert}>{p.attention}</PortalRowFact> : undefined}
          leading={<PropertyTile />}
          onSelectedChange={() => undefined}
          onOpen={() => setSelected(p)}
          dataAttr="property-list-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Residents ───────────────────────────── */

const RESIDENT_TABS = [
  { id: "potential", label: "Potential" },
  { id: "current", label: "Current" },
  { id: "past", label: "Past" },
];

export function ResidentsPanel({ story }: { story?: DemoStory } = {}) {
  const { residents: RESIDENT_ROWS, story: progress } = worldFor(story);
  const jordan = progress.applicationSubmitted ? (progress.applicationApproved && progress.leaseStep === 3 ? "current" : "potential") : null;
  const [tab, setTab] = useState<ResidentFixtureRow["tab"]>(jordan ?? "current");
  useEffect(() => {
    if (jordan !== null) setTab(jordan);
  }, [jordan]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ResidentFixtureRow | null>(null);
  const { show, node: toastNode } = useFixtureToast();

  const counts = useMemo(() => countBy(RESIDENT_ROWS, (r) => r.tab, ["potential", "current", "past"]), [RESIDENT_ROWS]);
  const rows = RESIDENT_ROWS.filter((r) => r.tab === tab && matchesSearch(search, r.name, r.email, r.place));

  return (
    <FixtureListScreen
      path="/portal/residents/current"
      sidebar={<PortalSidebarFixture active="residents" />}
      title="Residents"
      tabs={RESIDENT_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => setTab(id as ResidentFixtureRow["tab"])}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search residents"
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      primary={{ label: "Add resident", onClick: () => show("Add resident") }}
      isEmpty={rows.length === 0}
      emptyTitle="No residents here"
      emptySection="residents"
      menu={<FixtureMenuItems toast={show} items={tab === "potential" ? ["Approve", "Remind to finish", "Edit"] : ["Edit"]} />}
      overlay={
        <>
          <FixtureSheet open={!!selected} title={selected?.name ?? ""} onClose={() => setSelected(null)}>
            {selected ? (
              <>
                <FixtureField label="Home" value={selected.place} />
                <FixtureField label="Email" value={selected.email} />
                <FixtureField label="Lease start" value={selected.leaseStart} />
              </>
            ) : null}
          </FixtureSheet>
          {toastNode}
        </>
      }
    >
      {rows.map((r) => (
        <PortalApplicantRecordRow
          key={r.id}
          name={r.name}
          address={r.place}
          facts={
            <>
              <PortalRowFact icon={Mail}>{r.email}</PortalRowFact>
              {r.shared ? <PortalRowFact icon={Users}>{r.shared}</PortalRowFact> : null}
              <PortalRowFact icon={CalendarDays}>{r.leaseStart}</PortalRowFact>
              {r.status ? <span className="truncate">{r.status}</span> : null}
            </>
          }
          onSelectedChange={() => undefined}
          onOpen={() => setSelected(r)}
          dataAttr="resident-list-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Calendar ───────────────────────────── */

const CALENDAR_TABS = [
  { id: "all", label: "All" },
  { id: "tours", label: "Tours" },
  { id: "services", label: "Services" },
  { id: "tasks", label: "Tasks" },
];
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

function clock(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

export function CalendarPanel({ story }: { story?: DemoStory } = {}) {
  const { calendar: CALENDAR_ITEMS } = worldFor(story);
  const [tab, setTab] = useState("all");
  const [view, setView] = useState("week");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<CalendarGridItem | null>(null);
  const { show, node: toastNode } = useFixtureToast();

  const counts = useMemo(() => {
    const c = countBy(CALENDAR_ITEMS, (r) => r.kind, ["tour", "service", "task"]);
    return { all: CALENDAR_ITEMS.length, tours: c.tour, services: c.service, tasks: c.task };
  }, [CALENDAR_ITEMS]);

  const items = useMemo(() => {
    const kind = KIND_BY_TAB[tab];
    return CALENDAR_ITEMS.filter((i) => (!kind || i.kind === kind) && matchesSearch(search, i.title, i.place)).map(toGridItem);
  }, [CALENDAR_ITEMS, tab, search]);

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
  const open = (item: CalendarGridItem) => setSelected(item);
  const noop = () => undefined;
  const rangeLabel = view === "day" ? "Thu, Sep 25" : view === "month" ? "September 2025" : "Sep 22 - Sep 28";

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
          <PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />
          <PortalIconAction icon={CalendarClock} label="Availability" onClick={() => show("Availability")} />
        </>
      }
      primary={{ label: "Add event", onClick: () => show("Add tour, task or service") }}
      isEmpty={false}
      emptyTitle=""
      menu={null}
      surface={false}
      overlay={
        <>
          <FixtureSheet open={!!selected} title={selected?.title ?? ""} onClose={() => setSelected(null)}>
            {selected ? (
              <>
                <FixtureField label="Type" value={selected.kind === "tour" ? "Tour" : selected.kind === "service" ? "Service" : "Task"} />
                <FixtureField label="Where" value={selected.place} />
                <FixtureField label="When" value={`${clock(selected.startMin)} – ${clock(selected.startMin + selected.durationMin)}`} />
              </>
            ) : null}
          </FixtureSheet>
          {toastNode}
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-1" data-attr="calendar-nav">
            <button type="button" aria-label="Previous week" onClick={() => show("Previous week")} className="grid size-8 place-items-center rounded-full text-muted hover:bg-accent/60">
              <ChevronLeft className="size-4" />
            </button>
            <button type="button" onClick={() => show("Today")} className="h-8 rounded-full border border-border px-3 text-[13px] font-semibold text-foreground">
              Today
            </button>
            <button type="button" aria-label="Next week" onClick={() => show("Next week")} className="grid size-8 place-items-center rounded-full text-muted hover:bg-accent/60">
              <ChevronRight className="size-4" />
            </button>
            <span className="ml-1 text-[14px] font-bold text-foreground">{rangeLabel}</span>
          </div>
          <FieldSingleSelect
            hideLabel
            label="Calendar view"
            wrapperClassName="w-[6.75rem] shrink-0"
            value={view}
            onChange={setView}
            options={VIEW_OPTIONS}
          />
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

/* ───────────────────────────── Vendors ───────────────────────────── */

const VENDOR_TABS = [
  { id: "yours", label: "Your vendors" },
  { id: "catalog", label: "PropLane vendors" },
];

export function VendorsPanel({ story }: { story?: DemoStory } = {}) {
  const { vendors: VENDOR_ROWS } = worldFor(story);
  const [tab, setTab] = useState("yours");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{ title: string; fields: Array<[string, string]> } | null>(null);
  const { show, node: toastNode } = useFixtureToast();

  const yours = VENDOR_ROWS.filter((v) => matchesSearch(search, v.name, v.trade, v.email));
  const catalog = CATALOG_VENDORS.filter((v) => matchesSearch(search, v.name, v.trades, v.city));

  return (
    <FixtureListScreen
      path="/portal/vendors"
      sidebar={<PortalSidebarFixture active="vendors" />}
      title="Vendors"
      tabs={[
        { ...VENDOR_TABS[0]!, count: VENDOR_ROWS.length },
        { ...VENDOR_TABS[1]!, count: CATALOG_VENDORS.length },
      ]}
      activeId={tab}
      onTab={setTab}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search vendors"
      actions={
        tab === "catalog" ? (
          <PortalIconAction icon={Filter} label="Filter by trade or rating" onClick={() => show("Filter")} />
        ) : (
          <PortalIconAction icon={Settings} label="Vendor defaults" onClick={() => show("Vendor defaults")} />
        )
      }
      primary={{ label: "Add vendor", onClick: () => show("Add vendor") }}
      isEmpty={(tab === "yours" ? yours : catalog).length === 0}
      emptyTitle="No vendors here"
      emptySection="vendors"
      menu={<FixtureMenuItems toast={show} items={tab === "catalog" ? ["Add to your vendors"] : ["Edit", "Remove"]} />}
      overlay={
        <>
          <FixtureSheet open={!!selected} title={selected?.title ?? ""} onClose={() => setSelected(null)}>
            {selected?.fields.map(([label, value]) => <FixtureField key={label} label={label} value={value} />)}
          </FixtureSheet>
          {toastNode}
        </>
      }
    >
      {tab === "yours"
        ? yours.map((v) => (
            <PortalApplicantRecordRow
              key={v.id}
              name={v.name}
              address={v.trade}
              facts={
                <>
                  <PortalRowFact icon={Phone}>{v.phone}</PortalRowFact>
                  <PortalRowFact icon={Mail}>{v.email}</PortalRowFact>
                  {v.rating ? <PortalRowFact icon={Star}>{v.rating}</PortalRowFact> : null}
                  {v.rank ? <span className="truncate">{v.rank}</span> : null}
                </>
              }
              amount={v.services > 0 ? `${v.services} ${v.services === 1 ? "service" : "services"}` : undefined}
              onSelectedChange={() => undefined}
              onOpen={() =>
                setSelected({
                  title: v.name,
                  fields: [
                    ["Trade", v.trade],
                    ["Phone", v.phone],
                    ["Email", v.email],
                  ],
                })
              }
              dataAttr="vendor-list-row"
            />
          ))
        : catalog.map((v) => (
            <PortalPropertyRecordRow
              key={v.id}
              title={v.name}
              leading={
                <span className="flex h-[66px] w-[88px] shrink-0 items-center justify-center rounded-[10px] bg-secondary text-primary" aria-hidden>
                  <UserRound className="size-[22px]" strokeWidth={1.5} />
                </span>
              }
              facts={
                <>
                  <PortalRowFact icon={Wrench}>{v.trades}</PortalRowFact>
                  <PortalRowFact icon={MapPin}>{v.city}</PortalRowFact>
                  <PortalRowFact icon={ShieldCheck}>Insured</PortalRowFact>
                  <PortalRowFact icon={FileCheck2}>Licensed</PortalRowFact>
                  <PortalRowFact icon={Star}>{v.rating}</PortalRowFact>
                </>
              }
              onSelectedChange={() => undefined}
              onOpen={() =>
                setSelected({
                  title: v.name,
                  fields: [
                    ["Trades", v.trades],
                    ["City", v.city],
                    ["Rating", v.rating],
                  ],
                })
              }
              dataAttr="vendor-catalog-row"
            />
          ))}
    </FixtureListScreen>
  );
}
