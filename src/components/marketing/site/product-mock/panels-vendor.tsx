"use client";

/**
 * The vendor portal's tabs for the home page demo — Services, Calendar,
 * Payments, Reviews, Communication — drawn for Pacific Plumbing from the
 * shared "Seattle Homes" fixtures. Mirrors `vendor-work-orders-panel.tsx`
 * (tabs Open · Assigned · Scheduled · Completed, the "Near you" heading, an
 * offered job showing only its general area), `vendor-calendar-panel.tsx`
 * (the calendar's own week grid; tabs All · Services · Availability),
 * `vendor-finances-panel.tsx` (one merged list under a balance card),
 * `vendor-reviews-panel.tsx` (the stats card above All · Needs reply ·
 * Replied) and `vendor-communication.tsx`. The real panels fetch on mount, so
 * these compose the same presentational pieces from fixtures.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowUp,
  ArrowUpFromLine,
  Check,
  CalendarDays,
  CalendarSync,
  Clock,
  Download,
  FileText,
  Filter,
  Landmark,
  Settings,
  Sparkles,
  TriangleAlert,
  Undo2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { PortalApplicantRecordRow, PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { VENDOR_CHECKLIST, VENDOR_PAYOUTS, type VendorPayoutFixture } from "@/components/marketing/site/product-mock/fixtures-more";
import { CalendarTimeGrid, type CalendarGridItem } from "@/components/portal/manager-calendar-views";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { VendorRowMenu, type VendorRowMenuItem } from "@/components/portal/vendor-row-menu";
import { VendorReviewStarDisplay } from "@/components/portal/vendor-review-stars";
import type { GridBand, GridWindow } from "@/lib/calendar-grid";
import {
  AREA_BY_PROPERTY,
  CALENDAR_NOW_MIN,
  CALENDAR_TODAY,
  CALENDAR_WEEK,
  VENDOR_NAME,
  VENDOR_RATING,
  VENDOR_REVIEWS,
  type CommConversationFixture,
  type VendorPaymentFixture,
  type VendorReviewFixture,
  type VendorServiceFixture,
} from "@/components/marketing/site/product-mock/fixtures";
import {
  vendorPayments,
  vendorServices,
  vendorStory,
  vendorVisit,
  type DemoStory,
  type VendorVisit,
} from "@/components/marketing/site/product-mock/world";
import { countBy, FixtureInboxScreen, FixtureListScreen, FixtureMenuItems, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { FixtureField, FixtureSheet, useFixtureToast } from "@/components/marketing/site/product-mock/shared";

const CARD = "rounded-xl border border-border bg-card";

/* ───────────────────────────── Services ───────────────────────────── */

const SERVICE_TABS = [
  { id: "open", label: "Open" },
  { id: "assigned", label: "Assigned" },
  { id: "scheduled", label: "Scheduled" },
  { id: "completed", label: "Completed" },
];
const FACT_ICON: Record<VendorServiceFixture["factIcon"], LucideIcon> = {
  clock: Clock,
  sparkles: Sparkles,
  calendar: CalendarDays,
  check: Check,
};

/** The place line: a vendor not hired yet sees only the general area. */
function placeLine(s: VendorServiceFixture): string {
  if (!s.hired) return AREA_BY_PROPERTY[s.property] ?? s.property;
  return s.unit ? `${s.property} · ${s.unit}` : s.property;
}

export function VendorServicesPanel({ story }: { story?: DemoStory } = {}) {
  const services = useMemo(() => vendorServices(story ?? vendorStory(undefined)), [story]);
  const counts = useMemo(() => countBy(services, (s) => s.state, ["open", "assigned", "scheduled", "completed"]), [services]);
  // The faucet job is the first row whenever the story has reached the vendor.
  const jordan = services[0]?.id === "vsvc-willow-faucet" ? services[0].state : null;
  const [tab, setTab] = useState<string>(jordan ?? "open");
  useEffect(() => {
    if (jordan !== null) setTab(jordan);
  }, [jordan]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<VendorServiceFixture | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const rows = services.filter((s) => s.state === tab && matchesSearch(search, s.title, s.property));
  const nearYou = rows.filter((s) => !s.hired);
  const mine = rows.filter((s) => s.hired);

  const renderRow = (s: VendorServiceFixture) => {
    const Icon = FACT_ICON[s.factIcon];
    return (
      <PortalApplicantRecordRow
        key={s.id}
        name={s.title}
        tileLabel={placeLine(s)}
        address={placeLine(s)}
        facts={<PortalRowFact icon={Icon}>{s.fact}</PortalRowFact>}
        amount={s.figure}
        onSelectedChange={s.state === "scheduled" ? () => undefined : undefined}
        onOpen={() => setSelected(s)}
        dataAttr="vendor-service-row"
      />
    );
  };

  return (
    <FixtureListScreen
      path="/vendor/work-orders"
      title="Services"
      tabs={SERVICE_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={setTab}
      tabAriaLabel="Service status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search services"
      actions={
        <>
          <PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />
          <PortalIconAction icon={Settings} label="Service settings" onClick={() => show("Service settings")} />
        </>
      }
      primary={{ label: "Add bid", onClick: () => show("Add bid") }}
      isEmpty={rows.length === 0}
      emptyTitle={tab === "open" ? "No open services" : tab === "assigned" ? "Nothing assigned" : tab === "scheduled" ? "Nothing scheduled" : "Nothing completed yet"}
      emptySection="services"
      menu={tab === "scheduled" ? <FixtureMenuItems toast={show} items={["Complete"]} /> : undefined}
      overlay={
        <>
          <FixtureSheet
            open={!!selected}
            title={selected?.title ?? ""}
            onClose={() => setSelected(null)}
            primaryLabel={selected?.state === "open" ? "Send bid" : undefined}
            onPrimary={() => { show("Bid sent (sample)"); setSelected(null); }}
          >
            {selected ? (
              <>
                <FixtureField label="Where" value={placeLine(selected)} />
                <FixtureField label="Status" value={selected.fact} />
                {selected.figure ? <FixtureField label="Amount" value={selected.figure} /> : null}
              </>
            ) : null}
          </FixtureSheet>
          {toastNode}
        </>
      }
    >
      {nearYou.length > 0 ? (
        <>
          <p className="px-3 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted">Near you</p>
          {nearYou.map(renderRow)}
        </>
      ) : null}
      {mine.map(renderRow)}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Calendar ───────────────────────────── */

const CALENDAR_TABS = [
  { id: "all", label: "All" },
  { id: "services", label: "Services" },
  { id: "availability", label: "Availability" },
];
const GRID_WINDOW: GridWindow = { from: 8 * 60, to: 19 * 60, early: 0, late: 0 };

type VisitFixture = VendorVisit;
/** Pacific Plumbing's visits this week — the same services the Services tab lists. */
const VISITS: VisitFixture[] = [
  { id: "visit-disposal", dateStr: "2025-09-22", startMin: 13 * 60, durationMin: 60, title: "Garbage disposal repair", place: "Fremont Studio" },
  { id: "visit-faucet", dateStr: "2025-09-25", startMin: 10 * 60, durationMin: 120, title: "Kitchen faucet drip", place: "Alder House" },
];
/** The week after the standing one, where the Willow Court faucet visit lands (Thursday, Oct 2). */
const NEXT_WEEK = ["2025-09-29", "2025-09-30", "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04", "2025-10-05"];

function clock(min: number): string {
  const h = Math.floor(min / 60);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${min % 60 ? `:${String(min % 60).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

function visitToGridItem(v: VisitFixture): CalendarGridItem {
  return {
    id: v.id,
    kind: "service",
    dateStr: v.dateStr,
    startMin: v.startMin,
    durationMin: v.durationMin,
    allDay: false,
    title: v.title,
    place: v.place,
    requested: false,
    person: null,
    meeting: { id: v.id, source: "planned", sourceId: v.id, dateStr: v.dateStr, title: v.title, kind: "service" } as unknown as DemoMeeting,
  };
}

export function VendorCalendarPanel({ story }: { story?: DemoStory } = {}) {
  const visit = vendorVisit(story ?? vendorStory(undefined));
  // The grid shows the week the story's visit is in; the rows and counts below are only that week's.
  const week = visit ? NEXT_WEEK : CALENDAR_WEEK;
  /** Open hours: Monday to Friday, 8 AM to 4 PM. */
  const availabilityDays = week.slice(0, 5);
  const visits = useMemo(() => [...(visit ? [visit] : []), ...VISITS].filter((v) => week.includes(v.dateStr)), [visit, week]);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<CalendarGridItem | null>(null);
  const { show, node: toastNode } = useFixtureToast();

  const counts = { all: visits.length + availabilityDays.length, services: visits.length, availability: availabilityDays.length };
  const items = useMemo(
    () => (tab === "availability" ? [] : visits.filter((v) => matchesSearch(search, v.title, v.place)).map(visitToGridItem)),
    [visits, tab, search],
  );
  const bandsByDate = useMemo(() => {
    const map = new Map<string, GridBand[]>();
    if (tab !== "services") for (const ds of availabilityDays) map.set(ds, [{ startMin: 8 * 60, endMin: 16 * 60, kinds: ["services"], source: "typed" }]);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, week]);
  const noop = () => undefined;

  return (
    <FixtureListScreen
      path="/vendor/calendar"
      title="Calendar"
      tabs={CALENDAR_TABS.map((t) => ({ ...t, count: counts[t.id as keyof typeof counts] }))}
      activeId={tab}
      onTab={setTab}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search calendar"
      actions={<PortalIconAction icon={CalendarSync} label="Google Calendar · not connected" onClick={() => show("Google Calendar")} />}
      primary={{ label: "Add availability", onClick: () => show("Add availability") }}
      isEmpty={false}
      emptyTitle=""
      surface={false}
      overlay={
        <>
          <FixtureSheet open={!!selected} title={selected?.title ?? ""} onClose={() => setSelected(null)}>
            {selected ? (
              <>
                <FixtureField label="Where" value={selected.place} />
                <FixtureField label="When" value={`${clock(selected.startMin)} – ${clock(selected.startMin + selected.durationMin)}`} />
              </>
            ) : null}
          </FixtureSheet>
          {toastNode}
        </>
      }
    >
      <div className="overflow-hidden rounded-[14px] border border-border bg-card">
        <CalendarTimeGrid
          dates={week}
          items={items}
          bandsByDate={bandsByDate}
          window={GRID_WINDOW}
          expandEarly={false}
          expandLate={false}
          onToggleEarly={noop}
          onToggleLate={noop}
          todayDs={CALENDAR_TODAY}
          nowMin={CALENDAR_NOW_MIN}
          isDay={false}
          canEditAvailability={false}
          onOpenItem={(item) => setSelected(item)}
          onBandClick={noop}
          onDragAdd={noop}
          minColumnPx={96}
        />
      </div>
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Payments ───────────────────────────── */

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const parseMoney = (s: string) => Number(s.replace(/[$,]/g, ""));

export function VendorPaymentsPanel({ story }: { story?: DemoStory } = {}) {
  const payments = useMemo(() => vendorPayments(story ?? vendorStory(undefined)), [story]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<VendorPaymentFixture | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const rows = payments.filter((p) => matchesSearch(search, p.title, p.place, p.status));
  // The balance card is derived from the rows below it: money submitted but not
  // yet approved is pending; the newest paid invoice is what is available now.
  const pending = payments.filter((p) => p.status === "Submitted").reduce((sum, p) => sum + parseMoney(p.amount), 0);
  const available = parseMoney(payments.find((p) => p.status === "Paid")?.amount ?? "0");

  return (
    <FixtureListScreen
      path="/vendor/payments/pending"
      title="Incoming payments"
      tabs={[]}
      activeId=""
      onTab={() => undefined}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search payments"
      actions={
        <>
          <PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />
          <PortalIconAction icon={Download} label="Export invoices CSV" onClick={() => show("Export")} />
          <PortalIconAction icon={Settings} label="Payout setup" onClick={() => show("Payout setup")} />
        </>
      }
      primary={{ label: "Add payment", onClick: () => show("Add payment") }}
      above={
        <div className={`${CARD} mb-2 flex flex-wrap items-start justify-between gap-4 p-4`} data-attr="vendor-balance-card">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <p className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted">Available now</p>
              <p className="mt-1 text-2xl font-extrabold tracking-[-0.02em] text-foreground">{money(available)}</p>
            </div>
            <div>
              <p className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted">Pending</p>
              <p className="mt-1 text-2xl font-extrabold tracking-[-0.02em] text-foreground">{money(pending)}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {(
              [
                [FileText, "Statement"],
                [Undo2, "Refund"],
                [ArrowUpFromLine, "Withdraw"],
              ] as const
            ).map(([Icon, label]) => (
              <button
                key={label}
                type="button"
                aria-label={label}
                title={label}
                onClick={() => show(`${label} (sample)`)}
                className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-accent/60 hover:text-foreground"
              >
                <Icon className="size-[18px]" strokeWidth={1.6} aria-hidden />
              </button>
            ))}
          </div>
        </div>
      }
      isEmpty={rows.length === 0}
      emptyTitle="No payments yet"
      emptySection="payments"
      overlay={
        <>
          <FixtureSheet open={!!selected} title={selected?.title ?? ""} onClose={() => setSelected(null)}>
            {selected ? (
              <>
                <FixtureField label="Property" value={selected.place} />
                <FixtureField label="Date" value={selected.date} />
                <FixtureField label="Status" value={selected.status} />
                <FixtureField label="Amount" value={selected.amount} />
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
          address={p.place}
          facts={<span className="truncate">{`${p.date} · ${p.status}`}</span>}
          amount={p.amount}
          actions={
            <VendorRowMenu
              label={p.title}
              dataAttr="vendor-payment-row-menu"
              items={[
                { id: "view", label: "View invoice", onSelect: () => setSelected(p) },
                ...(p.status === "Submitted"
                  ? [
                      { id: "edit", label: "Edit", onSelect: () => show("Edit (sample)") },
                      { id: "withdraw", label: "Retract invoice", onSelect: () => show("Retract invoice (sample)") },
                    ]
                  : []),
                ...(p.status === "Paid" ? [{ id: "download", label: "Download", onSelect: () => show("Download (sample)") }] : []),
              ] satisfies VendorRowMenuItem[]}
            />
          }
          onOpen={() => setSelected(p)}
          dataAttr="vendor-payment-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Outgoing payments ───────────────────────────── */

const VENDOR_EXPENSES = [
  { id: "exp-1", title: "Faucet cartridge and supply line", category: "Materials", date: "Oct 1, 2025", amount: "$42.18" },
  { id: "exp-2", title: "Pipe wrench", category: "Tools", date: "Sep 29, 2025", amount: "$36.50" },
  { id: "exp-3", title: "Fuel", category: "Fuel", date: "Sep 24, 2025", amount: "$58.40" },
] as const;

export function VendorOutgoingPanel() {
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const rows = VENDOR_EXPENSES.filter((e) => matchesSearch(search, e.title, e.category));
  return (
    <FixtureListScreen
      path="/vendor/outgoing/this-month"
      title="Outgoing payments"
      tabs={[
        { id: "this-month", label: "This month", count: VENDOR_EXPENSES.length },
        { id: "last-month", label: "Last month" },
        { id: "earlier", label: "Earlier" },
      ]}
      activeId="this-month"
      onTab={() => undefined}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search expenses"
      actions={
        <>
          <PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />
          <PortalIconAction icon={Download} label="Download expenses" onClick={() => show("Download (sample)")} />
        </>
      }
      primary={{ label: "Add expense", onClick: () => show("Add expense") }}
      isEmpty={rows.length === 0}
      emptyTitle="No expenses yet"
      emptySection="payments"
      overlay={toastNode}
    >
      {rows.map((e) => (
        <PortalPropertyRecordRow
          key={e.id}
          title={e.title}
          address={e.category}
          facts={<span className="truncate">{e.date}</span>}
          amount={e.amount}
          actions={
            <VendorRowMenu
              label={e.title}
              dataAttr="vendor-expense-row-menu"
              items={[
                { id: "edit", label: "Edit", onSelect: () => show("Edit (sample)") },
                { id: "delete", label: "Delete", destructive: true, onSelect: () => show("Delete (sample)") },
              ] satisfies VendorRowMenuItem[]}
            />
          }
          onOpen={() => show("Expense (sample)")}
          dataAttr="vendor-expense-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Reviews ───────────────────────────── */

const REVIEW_TABS = [
  { id: "all", label: "All" },
  { id: "needs-reply", label: "Needs reply" },
  { id: "replied", label: "Replied" },
];

/** Reviews carry no reviewer name — a vendor never learns which manager wrote one. */
function ReviewCard({ review, onReply }: { review: VendorReviewFixture; onReply: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <article className={`${CARD} p-4`} data-attr="vendor-review-row">
      <div className="flex items-center justify-between gap-3">
        <VendorReviewStarDisplay stars={review.stars} size="md" />
        <span className="text-[12.5px] text-muted">{review.at}</span>
      </div>
      <p className="mt-2 text-[14px] text-foreground">{review.body}</p>
      {review.reply ? (
        <p className="mt-3 rounded-lg bg-accent/40 px-3 py-2 text-[13px] text-foreground/80">
          <span className="font-medium text-foreground">Your reply: </span>
          {review.reply}
        </p>
      ) : (
        <div className="mt-3 flex flex-col items-end gap-2">
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply to this review…"
            aria-label="Reply to this review"
            className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-primary"
          />
          <button
            type="button"
            onClick={() => {
              onReply(draft);
              setDraft("");
            }}
            className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-[12.5px] font-bold text-white"
          >
            Send reply
          </button>
        </div>
      )}
    </article>
  );
}

/** The stats card: overall rating plus the 5★ to 1★ distribution, bars scaled to the largest count. */
function ReviewStats() {
  const dist = [5, 4, 3, 2, 1].map((stars) => ({ stars, n: VENDOR_REVIEWS.filter((r) => r.stars === stars).length }));
  const max = Math.max(1, ...dist.map((d) => d.n));
  return (
    <section className={`${CARD} mb-2 p-4`} data-testid="vendor-reviews-stats">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-foreground">Overall</h3>
        <span className="flex items-center gap-2 text-[13.5px] text-foreground">
          <VendorReviewStarDisplay stars={VENDOR_RATING.average} size="md" />
          <span className="font-semibold">
            {VENDOR_RATING.average.toFixed(1)} ({VENDOR_RATING.count} {VENDOR_RATING.count === 1 ? "review" : "reviews"})
          </span>
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {dist.map((d) => (
          <div key={d.stars} className="flex items-center gap-2 text-[12.5px] text-muted">
            <span className="w-6 shrink-0">{d.stars}★</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent/60">
              <span className="block h-full rounded-full bg-primary" style={{ width: `${(d.n / max) * 100}%` }} />
            </span>
            <span className="w-4 shrink-0 text-right tabular-nums">{d.n}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function VendorReviewsPanel() {
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const { show, node: toastNode } = useFixtureToast();

  // A reply typed here lives in this panel only; the card then reads as replied.
  const reviews = useMemo(() => VENDOR_REVIEWS.map((r) => (replies[r.id] ? { ...r, reply: replies[r.id] } : r)), [replies]);
  const counts = { all: reviews.length, "needs-reply": reviews.filter((r) => !r.reply).length, replied: reviews.filter((r) => r.reply).length };
  const rows = reviews.filter(
    (r) => (tab === "all" || (tab === "needs-reply" ? !r.reply : Boolean(r.reply))) && matchesSearch(search, r.body, r.reply),
  );

  return (
    <FixtureListScreen
      path="/vendor/reviews"
      title="Reviews"
      tabs={REVIEW_TABS.map((t) => ({ ...t, count: counts[t.id as keyof typeof counts] }))}
      activeId={tab}
      onTab={setTab}
      tabAriaLabel="Review status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search reviews"
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      above={<ReviewStats />}
      isEmpty={false}
      emptyTitle=""
      surface={false}
      overlay={toastNode}
    >
      <div className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className={`${CARD} px-4 py-6 text-center text-[13px] text-muted`}>No reviews match these filters.</p>
        ) : (
          rows.map((r) => (
            <ReviewCard
              key={r.id}
              review={r}
              onReply={(text) => {
                if (!text.trim()) return;
                setReplies((m) => ({ ...m, [r.id]: text.trim() }));
                show("Reply sent (sample)");
              }}
            />
          ))
        )}
      </div>
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Communication ───────────────────────────── */

export function VendorCommunicationPanel({ conversations }: { conversations: CommConversationFixture[] }) {
  return <FixtureInboxScreen path="/vendor/communication/active" conversations={conversations} selfName={VENDOR_NAME} />;
}

/* ───────────────────────────── Documents ───────────────────────────── */

/**
 * `vendor-documents-panel.tsx`: a checklist in sections (Tax · Business license · Insurance), each header the
 * section name with "N of M" uploaded, each row a file glyph, the title, the file name once uploaded, and a plain
 * fact (Uploaded / Required / Not uploaded). Search, Filter and the round "Add document" are in the command bar.
 */
export function VendorDocumentsPanel() {
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const items = VENDOR_CHECKLIST.filter((item) => matchesSearch(search, item.title, item.file, item.section));
  const sections = ["Tax", "Business license", "Insurance"] as const;

  return (
    <FixtureListScreen
      path="/vendor/documents"
      title="Documents"
      tabs={[]}
      activeId=""
      onTab={() => undefined}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search documents"
      actions={<PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />}
      primary={{ label: "Add document", onClick: () => show("Add document") }}
      surface={false}
      isEmpty={items.length === 0}
      emptyTitle="No documents yet"
      emptySection="documents"
      overlay={toastNode}
    >
      <div className="space-y-5 pb-4">
        {sections.map((section) => {
          const all = VENDOR_CHECKLIST.filter((item) => item.section === section);
          const shown = items.filter((item) => item.section === section);
          if (shown.length === 0) return null;
          return (
            <section key={section} data-attr="vendor-documents-section">
              <div className="mb-1.5 flex items-center justify-between px-1">
                <h2 className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">{section}</h2>
                <span className="text-[12px] text-muted">
                  {all.filter((item) => item.file).length} of {all.length}
                </span>
              </div>
              <PortalRecordListSurface isEmpty={false} bulkActions={<FixtureMenuItems toast={show} items={["View", "Download", "Replace", "Delete"]} />}>
                {shown.map((item) => (
                  <PortalApplicantRecordRow
                    key={item.id}
                    name={item.title}
                    tileIcon={FileText}
                    address={item.file}
                    facts={
                      item.file ? (
                        <PortalRowFact icon={Check}>{item.uploaded}</PortalRowFact>
                      ) : item.required ? (
                        <PortalRowFact icon={TriangleAlert} tone="danger">
                          Required
                        </PortalRowFact>
                      ) : (
                        <PortalRowFact icon={Clock}>Not uploaded</PortalRowFact>
                      )
                    }
                    omitActionView
                    onSelectedChange={() => undefined}
                    onOpen={() => show(`${item.title} (sample)`)}
                    dataAttr="vendor-document-row"
                  />
                ))}
              </PortalRecordListSurface>
            </section>
          );
        })}
      </div>
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Finances: Balance & payouts ───────────────────────────── */

/**
 * `vendor-finances-panel.tsx`, the Balance & payouts section (where bare `/vendor/financials` lands): a stat strip
 * (Available · Pending · Held · On the way) with the Bank and Withdraw icon actions, one "Payouts" destination, and the
 * payout history rows. Every figure is read off the rows below; the faucet job's payout appears once it is paid.
 */
export function VendorFinancesPanel({ story }: { story?: DemoStory } = {}) {
  const current = story ?? vendorStory(undefined);
  const payments = vendorPayments(current);
  const payouts: VendorPayoutFixture[] = useMemo(
    () =>
      current.service === "paid"
        ? [{ id: "payout-faucet", kind: "Standard payout", bank: "Bank ····4821", date: "Oct 2, 2025", status: "In transit", amount: "$180.00" }, ...VENDOR_PAYOUTS]
        : VENDOR_PAYOUTS,
    [current.service],
  );
  const { show, node: toastNode } = useFixtureToast();
  const pending = payments.filter((p) => p.status === "Submitted").reduce((sum, p) => sum + parseMoney(p.amount), 0);
  const onTheWay = payouts.filter((p) => p.status === "In transit").reduce((sum, p) => sum + parseMoney(p.amount), 0);

  return (
    <FixtureListScreen
      path="/vendor/financials/balance"
      title="Finances"
      tabs={[{ id: "payouts", label: "Payouts", count: payouts.length }]}
      activeId="payouts"
      onTab={() => undefined}
      above={
        <div className="mb-2 flex items-stretch rounded-[10px] border border-border bg-card" data-attr="vendor-balance-strip">
          {(
            [
              ["Available", money(0)],
              ["Pending", money(pending)],
              ["Held", money(0)],
              ["On the way", money(onTheWay)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="min-w-0 flex-1 border-r border-border px-4 py-3">
              <p className="text-[13px] font-[550] text-muted">{label}</p>
              <p className="my-1 whitespace-nowrap text-[26px] font-[650] leading-[1.15] tracking-[-0.03em] text-foreground">{value}</p>
            </div>
          ))}
          <div className="flex shrink-0 items-start gap-1 px-2 py-2.5">
            <PortalIconAction icon={Landmark} label="Bank" onClick={() => show("Bank")} />
            <PortalIconAction icon={ArrowUpFromLine} label="Withdraw" onClick={() => show("Withdraw")} />
          </div>
        </div>
      }
      isEmpty={payouts.length === 0}
      emptyTitle="No payouts yet"
      emptySection="payments"
      overlay={toastNode}
    >
      {payouts.map((p) => (
        <PortalApplicantRecordRow
          key={p.id}
          name={p.kind}
          tileIcon={p.kind === "Instant payout" ? Zap : ArrowUp}
          address={p.bank}
          amount={p.amount}
          facts={
            <>
              <PortalRowFact icon={CalendarDays}>{p.date}</PortalRowFact>
              <span className="truncate">{p.status}</span>
              {p.fee ? <PortalRowFact icon={Zap}>{p.fee}</PortalRowFact> : null}
            </>
          }
          omitActionView
          onSelectedChange={() => undefined}
          onOpen={() => show(`${p.kind} (sample)`)}
          dataAttr="vendor-payout-row"
        />
      ))}
    </FixtureListScreen>
  );
}
