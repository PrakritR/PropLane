"use client";

/**
 * The manager sidebar's remaining tabs for the home demo (captain 2026-10-07: every sidebar item opens a panel
 * that mirrors its real page): Tasks, Bookings, Promotion, Forms, Outgoing payments, Finances and Documents.
 * Each copies the real page's structure, read from the code: the title, the tab labels with counts, the search
 * placeholder, the header icon actions and the round blue primary, and the row anatomy (tile, title, place line,
 * glyph facts, bold figure, the ⋯ menu). They compose the same real components the earlier panels do
 * (`FixtureListScreen` over `ManagerPortalPageShell`, `PortalListControlStack`, `PortalRecordListSurface`,
 * `PortalApplicantRecordRow`) and the real cash-flow chart, fed `fixtures-more.ts`. Nothing saves or fetches.
 * Sources: `manager-tasks-panel`, `pro-portfolio-bookings-calendar`, `manager-promotion-panel`,
 * `manager-forms-panel`, `manager-outgoing-payments`, `financials`, `manager-documents-panel`.
 */

import { useMemo, useState } from "react";
import {
  Banknote,
  BookOpen,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  FileSpreadsheet,
  FileText,
  Globe,
  Landmark,
  ListChecks,
  Lock,
  Megaphone,
  Scale,
  TrendingUp,
  Unlock,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { IntegrationRow } from "@/components/portal/integration-row";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { CHANNEL_GLYPH } from "@/components/portal/listing-sites-panel";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { listingChannelsByGroup, type ListingChannelGroup } from "@/lib/listing-channels/registry";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import type { MonthlyCashflowPoint } from "@/lib/portal-monthly-profit";
import {
  BOOKING_ROWS,
  DOCUMENT_ROWS,
  FINANCE_BY_PROPERTY,
  FINANCE_REPORTS,
  LISTING_SITES,
  MANAGER_FORMS,
  OUTGOING_ROWS,
  PROMOTION_ROWS,
  TASK_ROWS,
  type BookingFixtureRow,
  type DocumentFixtureRow,
  type ManagerFormFixture,
  type OutgoingFixtureRow,
  type PromotionFixtureRow,
  type TaskFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures-more";
import { countBy, FixtureListScreen, FixtureMenuItems, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { FixtureField, FixtureSheet, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import { PROPERTY_ROWS, type PropertyFixtureRow } from "@/components/marketing/site/product-mock/fixtures";
import { worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** The shared pop-up the rows open: title, a few default fields, nothing is saved. */
function useDetail() {
  const [detail, setDetail] = useState<{ title: string; fields: Array<[string, string]> } | null>(null);
  const sheet = (
    <FixtureSheet open={!!detail} title={detail?.title ?? ""} onClose={() => setDetail(null)}>
      {detail?.fields.map(([label, value]) => <FixtureField key={label} label={label} value={value} />)}
    </FixtureSheet>
  );
  return { open: setDetail, sheet };
}

/* ───────────────────────────── Tasks ───────────────────────────── */

const TASK_TABS = [
  { id: "open", label: "Open" },
  { id: "assigned", label: "Assigned" },
  { id: "scheduled", label: "Scheduled" },
  { id: "completed", label: "Completed" },
];
const TASK_EMPTY: Record<string, string> = { open: "No open tasks", assigned: "No assigned tasks", scheduled: "No scheduled tasks", completed: "No completed tasks" };

export function TasksPanel() {
  const [tab, setTab] = useState<TaskFixtureRow["bucket"]>("open");
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const detail = useDetail();
  const counts = useMemo(() => countBy(TASK_ROWS, (r) => r.bucket, TASK_TABS.map((t) => t.id)), []);
  const rows = TASK_ROWS.filter((r) => r.bucket === tab && matchesSearch(search, r.title, r.place, r.assignee));

  return (
    <FixtureListScreen
      path="/portal/tasks"
      title="Tasks"
      tabs={TASK_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => setTab(id as TaskFixtureRow["bucket"])}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search tasks"
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      primary={{ label: "Add task", onClick: () => show("Add task") }}
      isEmpty={rows.length === 0}
      emptyTitle={TASK_EMPTY[tab]!}
      emptySection="tasks"
      menu={<FixtureMenuItems toast={show} items={[tab === "completed" ? "Reopen" : "Complete", "Delete"]} />}
      overlay={
        <>
          {detail.sheet}
          {toastNode}
        </>
      }
    >
      {rows.map((r) => (
        <PortalApplicantRecordRow
          key={r.id}
          name={r.title}
          tileIcon={ListChecks}
          address={r.place}
          facts={
            <>
              <PortalRowFact icon={UserRound}>{r.assignee}</PortalRowFact>
              <PortalRowFact icon={r.bucket === "completed" ? CheckCircle2 : CalendarDays} tone={r.overdue ? "danger" : undefined}>
                {r.when}
              </PortalRowFact>
            </>
          }
          omitActionView
          onSelectedChange={() => undefined}
          onOpen={() => detail.open({ title: r.title, fields: [["Property", r.place], ["Assigned to", r.assignee], ["When", r.when]] })}
          dataAttr="task-list-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Bookings ───────────────────────────── */

const BOOKING_TABS = [
  { id: "calendar", label: "Calendar" },
  { id: "upcoming", label: "Upcoming" },
  { id: "inhouse", label: "In-house" },
  { id: "past", label: "Past" },
];
const BOOKING_EMPTY: Record<string, string> = { upcoming: "No upcoming bookings", inhouse: "No one in-house", past: "No past bookings" };
const STATUS_ICON: Record<BookingFixtureRow["status"], LucideIcon> = {
  Confirmed: CheckCircle2,
  "In-house": Building2,
  "Checked out": Clock,
  Hold: Lock,
};

/** The demo's calendar window: the three weeks around the demo's Sep 25. */
const DAYS = Array.from({ length: 21 }, (_, index) => new Date(2025, 8, 22 + index));
const DAY_INDEX = (month: number, day: number) => DAYS.findIndex((d) => d.getMonth() === month && d.getDate() === day);
const WEEKDAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const BAR_COLOR: Record<BookingFixtureRow["status"], string> = {
  Hold: "border border-dashed border-[#d9a441] bg-[#fff8e6] text-[#7a5a14]",
  Confirmed: "bg-[#e3f1e6] text-[#1f6b36]",
  "In-house": "bg-[#e1ebff] text-[#1c4fd6]",
  "Checked out": "bg-[#eceff3] text-[#5b6270]",
};

/** "Sep 22 – Sep 28" as day indexes in the window, clipped to it; null when the stay is wholly outside it. */
function barSpan(stay: string): { from: number; to: number } | null {
  const months: Record<string, number> = { Sep: 8, Oct: 9 };
  const parse = (label: string) => {
    const [month, day] = label.split(" ");
    return new Date(2025, months[month!]!, Number(day));
  };
  const [start, end] = stay.split(" – ").map(parse);
  if (!start || !end) return null;
  const first = DAYS[0]!.getTime();
  const last = DAYS[DAYS.length - 1]!.getTime();
  if (end.getTime() < first || start.getTime() > last) return null;
  const clip = (date: Date) => Math.min(DAYS.length - 1, Math.max(0, Math.round((date.getTime() - first) / 86400000)));
  return { from: clip(start), to: clip(end) };
}

function BookingsCalendarCard({ rows, onOpen }: { rows: BookingFixtureRow[]; onOpen: (row: BookingFixtureRow) => void }) {
  const todayIndex = DAY_INDEX(8, 25);
  const properties = PROPERTY_ROWS.map((p) => ({
    property: p,
    rows: rows.filter((r) => r.place.startsWith(p.title)),
  }));
  const staying = rows.filter((r) => r.status === "In-house").length;
  const checkIns = rows.filter((r) => r.bucket === "upcoming").length;
  const rooms = PROPERTY_ROWS.reduce((sum, p) => sum + (ROOMS_BY_PROPERTY[p.title]?.length ?? 1), 0);
  const occupied = new Set(rows.filter((r) => r.status === "In-house").map((r) => r.place)).size;

  return (
    <div className="space-y-2" data-attr="bookings-calendar">
      <div className="rounded-[10px] border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-label="Previous" className="grid size-8 place-items-center rounded-full text-foreground hover:bg-accent/60">
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button type="button" aria-label="Next" className="grid size-8 place-items-center rounded-full text-foreground hover:bg-accent/60">
            <ChevronRight className="size-4" aria-hidden />
          </button>
          <strong className="mr-1 text-[14px] font-bold text-foreground">September 2025</strong>
          <button type="button" className="rounded-full border border-border bg-card px-3 py-1 text-[13px] font-medium text-foreground">
            Today
          </button>
        </div>
        <p className="mb-1.5 mt-3 text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Calendar view</p>
        <div className="flex h-10 items-center justify-between rounded-lg border border-border bg-card px-3 text-[14px] text-foreground">
          <span>Month</span>
          <ChevronRight className="size-4 rotate-90 text-muted" aria-hidden />
        </div>

        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <div className="grid" style={{ gridTemplateColumns: `150px repeat(${DAYS.length}, minmax(0, 1fr))` }}>
            <div className="flex items-center px-3 text-[12px] font-medium text-foreground">Room</div>
            {DAYS.map((d, index) => (
              <div key={d.toISOString()} className={`border-l border-border py-1.5 text-center ${[0, 6].includes(d.getDay()) ? "bg-[#f4f5f7]" : ""}`}>
                <div className="text-[9px] font-medium text-muted">{WEEKDAY[d.getDay()]}</div>
                <div
                  className={`mx-auto mt-0.5 grid size-5 place-items-center rounded-full text-[11px] font-bold ${index === todayIndex ? "bg-primary text-white" : "text-foreground"}`}
                >
                  {d.getDate()}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-border bg-[#fbfbfc] px-3 py-2 text-[12px] text-foreground">
            {staying} staying · {checkIns} check-ins · 0 check-outs <span className="ml-2">{occupied} of {rooms} occupied · {Math.round((occupied / rooms) * 100)}%</span>
          </div>
          {properties.map(({ property, rows: stays }) => (
            <PropertyBlock key={property.id} property={property} stays={stays} onOpen={onOpen} />
          ))}
        </div>
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted" aria-label="Calendar colours">
        {[
          ["Hold", "bg-[#f3d9a4]"],
          ["Confirmed", "bg-[#2f8a4b]"],
          ["In-house", "bg-[#1f55e0]"],
          ["Checked out", "bg-[#9aa3b2]"],
          ["Airbnb / Booking.com", "bg-[#a04a14]"],
        ].map(([label, dot]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${dot}`} />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The bookable rows of each sample house: a row per room, or the whole home when it is let as one. */
const ROOMS_BY_PROPERTY: Record<string, string[]> = {
  "Alder House": ["Room 1", "Room 2", "Room 3"],
  "Maple Duplex": ["Unit A", "Unit B", "Unit C", "Unit D"],
  "Willow Court": ["Room 1", "Room 2", "Room 3"],
};

function PropertyBlock({ property, stays, onOpen }: { property: PropertyFixtureRow; stays: BookingFixtureRow[]; onOpen: (row: BookingFixtureRow) => void }) {
  const rooms = ROOMS_BY_PROPERTY[property.title] ?? ["Whole home"];
  return (
    <div className="border-t border-border">
      <div className="bg-[#f0f4fe] px-3 py-1.5 text-[12px] font-semibold text-foreground">{property.title}</div>
      {rooms.map((room) => {
        // A whole-home row holds the bookings that name no room; a room row holds the ones that end with its name.
        const own = stays.filter((s) => (room === "Whole home" ? !s.place.includes("·") : s.place.endsWith(room)));
        return (
          <div key={room} className="relative grid items-center border-t border-border" style={{ gridTemplateColumns: `150px repeat(${DAYS.length}, minmax(0, 1fr))`, minHeight: 34 }}>
            <div className="px-3 text-[12px] text-foreground">
              {room}
              <span className="ml-1.5 text-muted">{property.rentLabel}</span>
            </div>
            {DAYS.map((d) => (
              <div key={d.toISOString()} className={`h-full border-l border-border ${[0, 6].includes(d.getDay()) ? "bg-[#f4f5f7]" : ""}`} />
            ))}
            {own.map((stay) => {
              const span = barSpan(stay.stay);
              if (!span) return null;
              return (
                <button
                  key={stay.id}
                  type="button"
                  onClick={() => onOpen(stay)}
                  aria-label={`${stay.guest}, ${stay.status}`}
                  className={`absolute top-1 h-[26px] truncate rounded-lg px-2 text-left text-[11px] font-semibold ${BAR_COLOR[stay.status]}`}
                  style={{
                    left: `calc(150px + (100% - 150px) * ${span.from} / ${DAYS.length} + 2px)`,
                    width: `calc((100% - 150px) * ${span.to - span.from + 1} / ${DAYS.length} - 4px)`,
                  }}
                >
                  {stay.guest}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function BookingsPanel() {
  const [tab, setTab] = useState("calendar");
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const detail = useDetail();
  const counts = useMemo(() => countBy(BOOKING_ROWS, (r) => r.bucket, ["upcoming", "inhouse", "past"]), []);
  const rows = BOOKING_ROWS.filter((r) => r.bucket === tab && matchesSearch(search, r.guest, r.place));
  const open = (r: BookingFixtureRow) => detail.open({ title: r.guest, fields: [["Where", r.place], ["Stay", r.stay], ["Status", r.status], ["Rate", r.rate]] });

  return (
    <FixtureListScreen
      path="/portal/bookings/calendar"
      title="Bookings"
      tabs={BOOKING_TABS.map((t) => ({ ...t, count: t.id === "calendar" ? undefined : counts[t.id] }))}
      activeId={tab}
      onTab={setTab}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search bookings"
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      primary={{ label: "Add booking", onClick: () => show("Add booking") }}
      surface={tab !== "calendar"}
      isEmpty={rows.length === 0}
      emptyTitle={BOOKING_EMPTY[tab] ?? "No bookings"}
      emptySection="bookings"
      menu={<FixtureMenuItems toast={show} items={["Edit dates", "Message", "Cancel booking"]} />}
      overlay={
        <>
          {detail.sheet}
          {toastNode}
        </>
      }
    >
      {tab === "calendar" ? (
        <BookingsCalendarCard rows={BOOKING_ROWS} onOpen={open} />
      ) : (
        rows.map((r) => (
          <PortalApplicantRecordRow
            key={r.id}
            name={r.guest}
            address={r.place}
            amount={r.rate}
            facts={
              <>
                <PortalRowFact icon={CalendarDays}>{r.stay}</PortalRowFact>
                <PortalRowFact icon={STATUS_ICON[r.status]}>{r.status}</PortalRowFact>
                {r.source ? <PortalRowFact icon={Globe}>{r.source}</PortalRowFact> : null}
              </>
            }
            omitActionView
            onSelectedChange={() => undefined}
            onOpen={() => open(r)}
            dataAttr="booking-list-row"
          />
        ))
      )}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Promotion ───────────────────────────── */

const SITE_GROUPS: { id: ListingChannelGroup; label: string }[] = [
  { id: "automatic", label: "Automatic" },
  { id: "one_click", label: "One-click" },
  { id: "request_access", label: "Request access" },
];
const SITE_TOTAL = SITE_GROUPS.reduce((sum, g) => sum + listingChannelsByGroup(g.id).length, 0);

/** Promotion > Listing sites, drawn from the real piece's own rows (`WorkspaceListingSitesPanel`): the Listed with PropLane toggle,
 * the Automatic / One-click / Request access group tabs, and one IntegrationRow per real channel with its plain fact. */
function DemoListingSites({ houses }: { houses: number }) {
  const [group, setGroup] = useState<ListingChannelGroup>("automatic");
  const [attribution, setAttribution] = useState(true);
  const listings = (n: number) => `${n} of ${houses} ${houses === 1 ? "listing" : "listings"}`;
  return (
    <div data-attr="promotion-listing-sites">
      <IntegrationRow
        icon={ProPlaneMarkIcon}
        tone="text-primary"
        name="Show Listed with PropLane"
        action={<PortalSettingsToggle checked={attribution} onChange={setAttribution} label="Show Listed with PropLane" />}
      />
      <div className="px-4 pb-1 pt-3">
        <LocalDestinationNav
          items={SITE_GROUPS.map((g) => ({ id: g.id, label: g.label, count: listingChannelsByGroup(g.id).length }))}
          activeId={group}
          onChange={(id) => setGroup(id as ListingChannelGroup)}
          ariaLabel="Listing site group"
          appearance="command"
        />
      </div>
      {listingChannelsByGroup(group).map((def) => {
        const glyph = CHANNEL_GLYPH[def.id];
        if (group === "automatic") {
          return def.id === "zillow" ? (
            <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} fact={`${listings(3)} posting`} />
          ) : (
            <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} comingSoon />
          );
        }
        if (group === "one_click") return <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} fact={`${listings(0)} posted by me`} />;
        return <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} fact="Coming soon" />;
      })}
    </div>
  );
}

export function PromotionPanel() {
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const detail = useDetail();
  const counts = { all: PROMOTION_ROWS.length, text: PROMOTION_ROWS.filter((r) => r.bucket === "text").length, image: PROMOTION_ROWS.filter((r) => r.bucket === "image").length, sites: SITE_TOTAL };
  const rows: PromotionFixtureRow[] = PROMOTION_ROWS.filter((r) => (tab === "all" || r.bucket === tab) && matchesSearch(search, r.title, r.place, r.kind));

  return (
    <FixtureListScreen
      path="/portal/promotion"
      title="Promotion"
      tabs={[
        { id: "all", label: "All", count: counts.all },
        { id: "text", label: "Text", count: counts.text },
        { id: "image", label: "Image", count: counts.image },
        { id: "sites", label: "Listing sites", count: counts.sites },
      ]}
      activeId={tab}
      onTab={setTab}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search promotions"
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      primary={{ label: "Add promotion", onClick: () => show("Add promotion") }}
      isEmpty={tab !== "sites" && rows.length === 0}
      emptyTitle="No promotions yet"
      emptySection="promotion"
      menu={<FixtureMenuItems toast={show} items={["Edit", "Delete"]} />}
      overlay={
        <>
          {detail.sheet}
          {toastNode}
        </>
      }
    >
      {tab === "sites"
        ? <DemoListingSites houses={4} />
        : rows.map((r) => (
            <PortalApplicantRecordRow
              key={r.id}
              name={r.title}
              tileIcon={r.bucket === "image" ? Megaphone : FileText}
              address={r.place}
              facts={
                <>
                  <PortalRowFact icon={Megaphone}>{r.kind}</PortalRowFact>
                  <PortalRowFact icon={Clock}>{r.updated}</PortalRowFact>
                </>
              }
              omitActionView
              onSelectedChange={() => undefined}
              onOpen={() => detail.open({ title: r.title, fields: [["Property", r.place], ["Kind", r.kind], ["Updated", r.updated]] })}
              dataAttr="promotion-list-row"
            />
          ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Forms ───────────────────────────── */

const FORM_TABS = [
  { id: "pending", label: "Pending" },
  { id: "completed", label: "Completed" },
];

export function FormsPanel({ story }: { story?: DemoStory } = {}) {
  void story;
  const [tab, setTab] = useState<ManagerFormFixture["bucket"]>("pending");
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const detail = useDetail();
  const counts = useMemo(() => countBy(MANAGER_FORMS, (r) => r.bucket, ["pending", "completed"]), []);
  const rows = MANAGER_FORMS.filter((r) => r.bucket === tab && matchesSearch(search, r.title, r.resident, r.place));

  return (
    <FixtureListScreen
      path="/portal/forms"
      title="Forms"
      tabs={FORM_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => setTab(id as ManagerFormFixture["bucket"])}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search forms"
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      primary={{ label: "Add form", onClick: () => show("Add form") }}
      isEmpty={rows.length === 0}
      emptyTitle={tab === "pending" ? "No pending forms" : "No completed forms"}
      emptySection="forms"
      menu={<FixtureMenuItems toast={show} items={tab === "pending" ? ["Edit", "Remind", "Cancel request"] : ["View", "Download PDF"]} />}
      overlay={
        <>
          {detail.sheet}
          {toastNode}
        </>
      }
    >
      {rows.map((r) => (
        <PortalApplicantRecordRow
          key={r.id}
          name={r.title}
          tileLabel={r.resident}
          address={`${r.resident} · ${r.place}`}
          facts={
            <>
              <PortalRowFact icon={r.blocks === "Blocks nothing" ? Unlock : Lock}>{r.blocks}</PortalRowFact>
              <PortalRowFact icon={tab === "completed" ? CheckCircle2 : Clock} tone={r.late ? "danger" : undefined}>
                {r.when}
              </PortalRowFact>
            </>
          }
          omitActionView
          onSelectedChange={() => undefined}
          onOpen={() => detail.open({ title: r.title, fields: [["Resident", r.resident], ["Home", r.place], ["Status", r.when]] })}
          dataAttr="form-list-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Outgoing payments ───────────────────────────── */

const OUTGOING_TABS = [
  { id: "to-pay", label: "To pay" },
  { id: "scheduled", label: "Scheduled" },
  { id: "paid", label: "Paid" },
];
const OUTGOING_EMPTY: Record<string, string> = { "to-pay": "Nothing to pay", scheduled: "Nothing scheduled", paid: "No payments yet" };
const METHOD_ICON: Record<OutgoingFixtureRow["method"], LucideIcon> = { "PropLane balance": Wallet, Bank: Landmark, "Card or bank account": Banknote };

export function OutgoingPaymentsPanel({ story }: { story?: DemoStory } = {}) {
  void story;
  const [tab, setTab] = useState<OutgoingFixtureRow["bucket"]>("to-pay");
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const detail = useDetail();
  const counts = useMemo(() => countBy(OUTGOING_ROWS, (r) => r.bucket, OUTGOING_TABS.map((t) => t.id)), []);
  const totals = useMemo(() => {
    const out: Record<string, number> = { "to-pay": 0, scheduled: 0, paid: 0 };
    for (const r of OUTGOING_ROWS) out[r.bucket] = (out[r.bucket] ?? 0) + Number(r.amount.replace(/[$,]/g, ""));
    return out;
  }, []);
  const rows = OUTGOING_ROWS.filter((r) => r.bucket === tab && matchesSearch(search, r.vendor, r.detail, r.property));

  return (
    <FixtureListScreen
      path="/portal/outgoing/to-pay"
      title="Outgoing payments"
      tabs={OUTGOING_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => setTab(id as OutgoingFixtureRow["bucket"])}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search outgoing payments"
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      primary={{ label: "Add payment", onClick: () => show("Add payment") }}
      above={
        <div className="mb-2 grid grid-cols-3 gap-3" data-attr="outgoing-stats">
          {OUTGOING_TABS.map((t) => (
            <div key={t.id} className="rounded-[10px] border border-border bg-card px-4 py-3">
              <p className="text-[13px] font-[550] text-muted">{t.label}</p>
              <p className="my-1 text-[22px] font-[650] leading-[1.15] tracking-[-0.03em] text-foreground">{usd(totals[t.id]!)}</p>
            </div>
          ))}
        </div>
      }
      isEmpty={rows.length === 0}
      emptyTitle={OUTGOING_EMPTY[tab]!}
      emptySection="outgoing"
      menu={<FixtureMenuItems toast={show} items={tab === "paid" ? ["View payment", "Open service"] : ["Pay now", "Schedule payment", "View invoice"]} />}
      overlay={
        <>
          {detail.sheet}
          {toastNode}
        </>
      }
    >
      {rows.map((r) => (
        <PortalApplicantRecordRow
          key={r.id}
          name={r.vendor}
          address={`${r.detail} · ${r.property}`}
          amount={r.amount}
          facts={
            <>
              <PortalRowFact icon={tab === "paid" ? CalendarDays : Clock}>{r.when}</PortalRowFact>
              <PortalRowFact icon={METHOD_ICON[r.method]}>{r.method}</PortalRowFact>
            </>
          }
          omitActionView
          onSelectedChange={() => undefined}
          onOpen={() => detail.open({ title: r.vendor, fields: [["For", `${r.detail} · ${r.property}`], ["When", r.when], ["Paid from", r.method], ["Amount", r.amount]] })}
          dataAttr="outgoing-list-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Finances ───────────────────────────── */

const FINANCE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "reports", label: "Reports" },
];
const REPORT_ICONS: LucideIcon[] = [TrendingUp, Building2, BookOpen, TrendingUp, Scale, Landmark, BookOpen, Building2, Wallet];

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "ok" }) {
  return (
    <div className="min-w-0 flex-1 px-4 py-3">
      <p className="text-[13px] font-[550] text-muted">{label}</p>
      <p className={`my-1 whitespace-nowrap text-[26px] font-[650] leading-[1.15] tracking-[-0.03em] ${tone === "ok" ? "text-[var(--status-confirmed-fg)]" : "text-foreground"}`}>{value}</p>
      {note ? <p className="text-[12.5px] text-muted">{note}</p> : null}
    </div>
  );
}

/** Twelve months of the demo's cash flow, ending September: the same shape the Dashboard's chart draws. */
const FINANCE_POINTS: MonthlyCashflowPoint[] = [
  [0, 0], [0, 0], [1650, 0], [1650, 900], [2100, 1000], [1700, 1300], [2300, 1400], [2800, 1500], [3300, 2100], [4300, 2500], [6600, 2200], [8950, 655],
].map(([revenue, expense], index) => {
  const at = new Date(2024, 9 + index, 1);
  return {
    key: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`,
    label: at.toLocaleString("en-US", { month: "short" }),
    revenue: revenue!,
    expense: expense!,
    profit: revenue! - expense!,
  };
});

export function FinancesPanel({ story }: { story?: DemoStory } = {}) {
  const world = worldFor(story);
  const [tab, setTab] = useState("overview");
  const { show, node: toastNode } = useFixtureToast();
  const revenue = FINANCE_BY_PROPERTY.reduce((sum, p) => sum + p.in, 0);
  const expenses = FINANCE_BY_PROPERTY.reduce((sum, p) => sum + p.out, 0);
  const toPay = OUTGOING_ROWS.filter((r) => r.bucket === "to-pay");
  const pending = world.payments.filter((p) => p.bucket === "pending" || p.bucket === "overdue").reduce((sum, p) => sum + Number(p.amount.replace(/[$,]/g, "")), 0);
  const collected = world.payments.filter((p) => p.bucket === "paid").reduce((sum, p) => sum + Number(p.amount.replace(/[$,]/g, "")), 0);

  return (
    <FixtureListScreen
      path="/portal/financials/overview"
      title="Finances"
      tabs={FINANCE_TABS}
      activeId={tab}
      onTab={setTab}
      primary={tab === "overview" ? { label: "Add financial entry", onClick: () => show("Add financial entry") } : undefined}
      surface={tab === "reports"}
      isEmpty={false}
      emptyTitle="No entries yet"
      emptySection="financials"
      menu={<FixtureMenuItems toast={show} items={["View", "Download CSV", "Download PDF"]} />}
      overlay={toastNode}
    >
      {tab === "overview" ? (
        <div className="space-y-4 pb-4" data-attr="finances-overview">
          <div className="flex divide-x divide-border rounded-[10px] border border-border bg-card">
            <Stat label="Available" value={usd(collected + 8800)} />
            <Stat label="Pending" value={usd(pending)} />
            <Stat label="Held deposits" value={usd(RESIDENT_DEPOSITS)} />
            <Stat label="To pay" value={usd(toPay.reduce((sum, r) => sum + Number(r.amount.replace(/[$,]/g, "")), 0))} note={`${toPay.length} bills`} />
          </div>
          <div className="flex items-center justify-between">
            <span className="rounded-full border border-border bg-card px-3 py-1 text-[13px] font-medium text-foreground">September 2025</span>
            <PortalIconAction icon={Landmark} label="Balance & payouts" onClick={() => show("Balance & payouts")} />
          </div>
          <div className="flex divide-x divide-border rounded-[10px] border border-border bg-card">
            <Stat label="Revenue" value={usd(revenue)} tone={revenue > 0 ? "ok" : undefined} />
            <Stat label="Expenses" value={usd(expenses)} />
            <Stat label="Profit" value={usd(revenue - expenses)} tone={revenue - expenses > 0 ? "ok" : undefined} />
          </div>
          <section className="overflow-hidden rounded-[10px] border border-border bg-card">
            <div className="border-b border-border px-3.5 py-[11px]">
              <h2 className="text-sm font-[650] text-foreground">By property</h2>
            </div>
            <ul className="divide-y divide-border">
              {FINANCE_BY_PROPERTY.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <span className="grid size-9 place-items-center rounded-lg bg-accent/60 text-muted">
                    <Building2 className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{p.title}</span>
                  <span className="text-[12.5px] text-[var(--status-confirmed-fg)]">In {usd(p.in)}</span>
                  <span className="text-[12.5px] text-muted">Out {usd(p.out)}</span>
                </li>
              ))}
            </ul>
          </section>
          <MonthlyProfitChart points={FINANCE_POINTS} />
        </div>
      ) : (
        FINANCE_REPORTS.map((title, index) => (
          <PortalApplicantRecordRow key={title} name={title} tileIcon={REPORT_ICONS[index] ?? FileSpreadsheet} omitActionView onSelectedChange={() => undefined} onOpen={() => show(`${title} (sample)`)} dataAttr="finance-report-row" />
        ))
      )}
    </FixtureListScreen>
  );
}

/** Security deposits the sample workspace holds: one month's rent per current resident, from the rows the Residents tab draws. */
const RESIDENT_DEPOSITS = PROPERTY_ROWS.reduce((sum, p) => sum + Number(p.rentLabel.replace(/[^0-9]/g, "")) * Math.min(p.rooms, 2), 0);

/* ───────────────────────────── Documents ───────────────────────────── */

const DOCUMENT_TABS = [
  { id: "applications", label: "Applications" },
  { id: "leases", label: "Leases" },
  { id: "other", label: "Other documents" },
];
const DOCUMENT_EMPTY: Record<string, string> = { applications: "No application documents yet", leases: "No lease documents yet", other: "No documents yet" };

export function DocumentsPanel({ story }: { story?: DemoStory } = {}) {
  void story;
  const [tab, setTab] = useState<DocumentFixtureRow["bucket"]>("applications");
  const { show, node: toastNode } = useFixtureToast();
  const detail = useDetail();
  const counts = useMemo(() => countBy(DOCUMENT_ROWS, (r) => r.bucket, DOCUMENT_TABS.map((t) => t.id)), []);
  const rows = DOCUMENT_ROWS.filter((r) => r.bucket === tab);

  return (
    <FixtureListScreen
      path="/portal/documents/applications"
      title="Documents"
      tabs={DOCUMENT_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => setTab(id as DocumentFixtureRow["bucket"])}
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      primary={{ label: "Add document", onClick: () => show("Add document") }}
      isEmpty={rows.length === 0}
      emptyTitle={DOCUMENT_EMPTY[tab]!}
      emptySection="documents"
      menu={<FixtureMenuItems toast={show} items={tab === "other" ? ["Share with owners"] : ["Export"]} />}
      overlay={
        <>
          {detail.sheet}
          {toastNode}
        </>
      }
    >
      {rows.map((r) => (
        <PortalApplicantRecordRow
          key={r.id}
          name={r.title}
          tileIcon={tab === "other" ? FileText : undefined}
          address={r.meta}
          facts={r.trailing ? <span className="truncate">{r.trailing}</span> : undefined}
          omitActionView
          onSelectedChange={() => undefined}
          onOpen={() => detail.open({ title: r.title, fields: [["Details", r.meta]] })}
          dataAttr="document-list-row"
        />
      ))}
    </FixtureListScreen>
  );
}
