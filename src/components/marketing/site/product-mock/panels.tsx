"use client";

/**
 * The home page's product panels — captain 2026-09-26: "remove live demo no
 * need" + the Codex-style redesign. Each panel reuses the REAL portal
 * presentational components (`PortalRecordListSurface`, `PortalApplicantRecordRow`,
 * `PortalServiceRecordRow`, `ManagerPortalPageShell`, `PortalListControlStack`,
 * `PortalIconAction`, `KpiCard`, `AttentionPanel`, `UpcomingPanel`,
 * `PortfolioPropertiesSection`, `PortfolioImportReviewStep`) fed the static
 * fixtures in `fixtures.ts` — never a hand-drawn lookalike, never a network
 * request. Tabs and search filter the fixture rows client-side; the primary
 * action and row clicks open `FixtureSheet` with default values; the row's
 * "⋯" is the real kebab (`PortalRecordListSurface`'s `bulkActions` slot).
 * "Save"/"Approve" only closes the sheet and shows the real toast pattern —
 * nothing persists, nothing fetches (see the file's own docstring in
 * `shared.tsx` and `docs/agents/marketing-mocks.md`).
 */

import { useMemo, useState } from "react";
import {
  Bell,
  CalendarDays,
  Clock,
  Download,
  Filter,
  Mail,
  Phone,
  Home,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Share2,
  Users,
  Video,
} from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact, PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { AttentionPanel, KpiCard, UpcomingPanel } from "@/components/portal/pro-dashboard-kpis";
import { PortfolioPropertiesSection, type PortfolioPropertyCardData } from "@/components/portal/pro-dashboard-portfolio";
import { PortfolioImportReviewStep } from "@/components/portal/portfolio-import/review-step";
import { DEMO_IMPORT_SAMPLE } from "@/lib/demo/demo-import-sample";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  APPLICATION_ROWS,
  DASHBOARD_ATTENTION,
  DASHBOARD_KPIS,
  DASHBOARD_PROPERTIES,
  DASHBOARD_UPCOMING,
  LEASE_ROWS,
  PAYMENT_ROWS,
  SERVICE_ROWS,
  TOUR_ROWS,
  type ApplicationFixtureRow,
  type LeaseFixtureRow,
  type PaymentFixtureRow,
  type ServiceFixtureRow,
  type TourFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";
import { FixtureField, FixtureSheet, FixtureTabs, PortalSidebarFixture, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";

/** The real kebab: `RowSelectCheckbox` only renders `RecordActionMenu` when
 * the enclosing surface got `bulkActions` — two static, no-op actions is
 * enough to prove the real "⋯" opens, without inventing new mutation UI. */
function useFixtureKebab(toast: (text: string) => void, noun: string) {
  return (
    <>
      <DropdownMenuItem onSelect={() => toast(`${noun} archived`)}>Archive</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => toast(`${noun} muted`)}>Mute reminders</DropdownMenuItem>
    </>
  );
}

function filterBySearch<T extends { search: string }>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => row.search.includes(q));
}

/* ───────────────────────────── Tours ───────────────────────────── */

const TOUR_TABS = [
  { id: "pending" as const, label: "Pending" },
  { id: "upcoming" as const, label: "Upcoming" },
  { id: "past" as const, label: "Past" },
];

export function ToursPanel() {
  const [bucket, setBucket] = useState<TourFixtureRow["bucket"]>("upcoming");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<TourFixtureRow | null>(null);
  const [adding, setAdding] = useState(false);
  const { show, node: toastNode } = useFixtureToast();
  const kebab = useFixtureKebab(show, "Tour");

  const counts = useMemo(() => {
    const c: Record<string, number> = { pending: 0, upcoming: 0, past: 0 };
    for (const r of TOUR_ROWS) c[r.bucket] = (c[r.bucket] ?? 0) + 1;
    return c;
  }, []);
  const rows = useMemo(
    () => filterBySearch(TOUR_ROWS.filter((r) => r.bucket === bucket).map((r) => ({ ...r, search: `${r.guest} ${r.place}`.toLowerCase() })), search),
    [bucket, search],
  );

  return (
    <ProductWindow path="/portal/tours/upcoming">
      <PortalSidebarFixture active="tours" counts={{ tours: counts.pending }} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ManagerPortalPageShell title="Tours">
          <PortalListControlStack
            variant="command"
            destinationRow={<FixtureTabs tabs={TOUR_TABS.map((t) => ({ ...t, count: counts[t.id] }))} active={bucket} onChange={setBucket} />}
            search={{ value: search, onChange: setSearch, placeholder: "Search tours" }}
            actions={
              <>
                <PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />
                <PortalIconAction icon={Download} label="Export" onClick={() => show("Export")} />
                <PortalIconAction icon={Share2} label="Share tour link" onClick={() => show("Tour link copied")} />
                <PortalIconAction icon={Settings} label="Settings" onClick={() => show("Settings")} />
              </>
            }
            primary={<PortalPrimaryIconAction label="Add tour" onClick={() => setAdding(true)} />}
          />
          <PortalRecordListSurface
            isEmpty={rows.length === 0}
            emptyCard={{ title: "No tours here", section: bucket }}
            bulkActions={kebab}
          >
            {rows.map((row) => (
              <PortalApplicantRecordRow
                key={row.id}
                name={row.guest}
                address={row.place}
                facts={
                  <>
                    <PortalRowFact icon={CalendarDays}>{row.when}</PortalRowFact>
                    {row.format === "virtual" ? <PortalRowFact icon={Video}>Virtual</PortalRowFact> : null}
                    <PortalRowFact icon={Mail}>{row.email}</PortalRowFact>
                    <PortalRowFact icon={Phone}>{row.phone}</PortalRowFact>
                    {row.reminder ? (
                      <PortalRowFact icon={Bell}>
                        <span data-attr="tours-row-scheduled">{row.reminder}</span>
                      </PortalRowFact>
                    ) : null}
                  </>
                }
                onSelectedChange={() => undefined}
                onOpen={() => setSelected(row)}
                dataAttr="tour-list-row"
              />
            ))}
          </PortalRecordListSurface>
        </ManagerPortalPageShell>
      </div>
      <FixtureSheet open={!!selected} title={selected?.guest ?? ""} onClose={() => setSelected(null)} primaryLabel="Confirm tour" onPrimary={() => { show("Tour confirmed"); setSelected(null); }}>
        {selected ? (
          <>
            <FixtureField label="Property" value={selected.place} />
            <FixtureField label="When" value={selected.when} />
            <FixtureField label="Guest" value={`${selected.guest} · ${selected.email}`} />
          </>
        ) : null}
      </FixtureSheet>
      <FixtureSheet open={adding} title="Add tour" onClose={() => setAdding(false)} primaryLabel="Save" onPrimary={() => { show("Tour added"); setAdding(false); }}>
        <FixtureField label="Property" value="Fremont Studio" />
        <FixtureField label="Date & time" value="Sat, Sep 27 · 2:00 PM" />
        <FixtureField label="Guest" value="New prospect" />
      </FixtureSheet>
      {toastNode}
    </ProductWindow>
  );
}

/* ───────────────────────────── Applications ───────────────────────────── */

const APPLICATION_TABS = [
  { id: "incomplete" as const, label: "Incomplete" },
  { id: "pending" as const, label: "Pending" },
  { id: "approved" as const, label: "Approved" },
  { id: "rejected" as const, label: "Rejected" },
];

export function ApplicationsPanel() {
  const [bucket, setBucket] = useState<ApplicationFixtureRow["bucket"]>("pending");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ApplicationFixtureRow | null>(null);
  const [adding, setAdding] = useState(false);
  const { show, node: toastNode } = useFixtureToast();
  const kebab = useFixtureKebab(show, "Application");

  const counts = useMemo(() => {
    const c: Record<string, number> = { incomplete: 0, pending: 0, approved: 0, rejected: 0 };
    for (const r of APPLICATION_ROWS) c[r.bucket] = (c[r.bucket] ?? 0) + 1;
    return c;
  }, []);
  const rows = useMemo(
    () => filterBySearch(APPLICATION_ROWS.filter((r) => r.bucket === bucket).map((r) => ({ ...r, search: `${r.name} ${r.property}`.toLowerCase() })), search),
    [bucket, search],
  );

  return (
    <ProductWindow path="/portal/applications/pending">
      <PortalSidebarFixture active="applications" counts={{ applications: counts.pending }} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ManagerPortalPageShell title="Applications">
          <PortalListControlStack
            variant="command"
            destinationRow={<FixtureTabs tabs={APPLICATION_TABS.map((t) => ({ ...t, count: counts[t.id] }))} active={bucket} onChange={setBucket} />}
            search={{ value: search, onChange: setSearch, placeholder: "Search applications" }}
            actions={
              <>
                <PortalIconAction icon={Filter} label="Filter" onClick={() => show("Filter")} />
                <PortalIconAction icon={Share2} label="Send application link" onClick={() => show("Application link copied")} />
                <PortalIconAction icon={Settings} label="Settings" onClick={() => show("Settings")} />
              </>
            }
            primary={<PortalPrimaryIconAction label="Add application" onClick={() => setAdding(true)} />}
          />
          <PortalRecordListSurface
            isEmpty={rows.length === 0}
            emptyCard={{ title: "No applications here", section: bucket }}
            bulkActions={kebab}
          >
            {rows.map((row) => (
              <PortalApplicantRecordRow
                key={row.id}
                name={row.name}
                address={`${row.property} · ${row.unit}`}
                facts={
                  <>
                    <PortalRowFact icon={Mail}>{row.email}</PortalRowFact>
                    <PortalRowFact icon={Clock}>{row.submitted}</PortalRowFact>
                    <PortalRowFact icon={Home}>{row.stage}</PortalRowFact>
                    {row.sharedFact ? <PortalRowFact icon={Users}>{row.sharedFact}</PortalRowFact> : null}
                    {row.screening === "flagged" ? (
                      <PortalRowFact icon={ShieldAlert}>Screening flagged</PortalRowFact>
                    ) : row.screening === "passed" ? (
                      <PortalRowFact icon={ShieldCheck}>Screening passed</PortalRowFact>
                    ) : null}
                  </>
                }
                onSelectedChange={() => undefined}
                onOpen={() => setSelected(row)}
                dataAttr="application-list-row"
              />
            ))}
          </PortalRecordListSurface>
        </ManagerPortalPageShell>
      </div>
      <FixtureSheet open={!!selected} title={selected?.name ?? ""} onClose={() => setSelected(null)} primaryLabel="Approve" onPrimary={() => { show("Application approved"); setSelected(null); }}>
        {selected ? (
          <>
            <FixtureField label="Property" value={`${selected.property} · ${selected.unit}`} />
            <FixtureField label="Submitted" value={selected.submitted} />
            <FixtureField label="Stage" value={selected.stage} />
          </>
        ) : null}
      </FixtureSheet>
      <FixtureSheet open={adding} title="Add application" onClose={() => setAdding(false)} primaryLabel="Save" onPrimary={() => { show("Application added"); setAdding(false); }}>
        <FixtureField label="Property" value="Fremont Studio" />
        <FixtureField label="Applicant" value="New applicant" />
      </FixtureSheet>
      {toastNode}
    </ProductWindow>
  );
}

/* ───────────────────────────── Leasing ───────────────────────────── */

const LEASE_TABS = [
  { id: "manager" as const, label: "Manager review" },
  { id: "resident" as const, label: "Resident signature" },
  { id: "signed" as const, label: "Manager signature" },
  { id: "completed" as const, label: "Signed" },
];

/** Same tone map `pro-leases.tsx` draws its pipeline progress segments in. */
const LEASE_SEGMENT_TONE: Record<LeaseFixtureRow["bucket"], string> = {
  manager: "bg-amber-400",
  resident: "bg-sky-400",
  signed: "bg-violet-400",
  completed: "bg-emerald-500",
};

export function LeasesPanel() {
  const [bucket, setBucket] = useState<LeaseFixtureRow["bucket"]>("signed");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<LeaseFixtureRow | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const kebab = useFixtureKebab(show, "Lease");

  const counts = useMemo(() => {
    const c: Record<string, number> = { manager: 0, resident: 0, signed: 0, completed: 0 };
    for (const r of LEASE_ROWS) c[r.bucket] = (c[r.bucket] ?? 0) + 1;
    return c;
  }, []);
  const total = LEASE_ROWS.length;
  const rows = useMemo(
    () => filterBySearch(LEASE_ROWS.filter((r) => r.bucket === bucket).map((r) => ({ ...r, search: `${r.resident} ${r.place}`.toLowerCase() })), search),
    [bucket, search],
  );

  return (
    <ProductWindow path="/portal/leases">
      <PortalSidebarFixture active="leases" />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ManagerPortalPageShell title="Leases">
          <div className="mb-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
            <p className="text-[13px] font-medium text-foreground">{counts.completed} of {total} leases signed</p>
            <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-accent/40">
              {(["manager", "resident", "signed", "completed"] as const).map((id) =>
                counts[id] > 0 ? (
                  <span
                    key={id}
                    className={LEASE_SEGMENT_TONE[id]}
                    style={{ width: `${(counts[id] / total) * 100}%` }}
                    role="img"
                    aria-label={`${LEASE_TABS.find((t) => t.id === id)?.label}: ${counts[id]}`}
                  />
                ) : null,
              )}
            </div>
          </div>
          <PortalListControlStack
            variant="command"
            destinationRow={<FixtureTabs tabs={LEASE_TABS.map((t) => ({ ...t, count: counts[t.id] }))} active={bucket} onChange={setBucket} />}
            search={{ value: search, onChange: setSearch, placeholder: "Search leases" }}
            actions={<PortalIconAction icon={Settings} label="Settings" onClick={() => show("Settings")} />}
          />
          <PortalRecordListSurface isEmpty={rows.length === 0} emptyCard={{ title: "No leases here", section: bucket }} bulkActions={kebab}>
            {rows.map((row) => (
              <PortalApplicantRecordRow
                key={row.id}
                name={row.resident}
                address={row.place}
                facts={
                  <>
                    <PortalRowFact icon={Mail}>{row.email}</PortalRowFact>
                    <PortalRowFact icon={CalendarDays}>{row.stage}</PortalRowFact>
                    <PortalRowFact icon={Clock}>{row.updated}</PortalRowFact>
                  </>
                }
                onSelectedChange={() => undefined}
                onOpen={() => setSelected(row)}
                dataAttr="lease-list-row"
              />
            ))}
          </PortalRecordListSurface>
        </ManagerPortalPageShell>
      </div>
      <FixtureSheet
        open={!!selected}
        title={selected?.resident ?? ""}
        onClose={() => setSelected(null)}
        primaryLabel="Countersign"
        onPrimary={() => { show("Lease executed — deposit charge sent"); setSelected(null); }}
      >
        {selected ? (
          <>
            <FixtureField label="Property" value={selected.place} />
            <FixtureField label="Stage" value={selected.stage} />
            <FixtureField label="Last update" value={selected.updated} />
          </>
        ) : null}
      </FixtureSheet>
      {toastNode}
    </ProductWindow>
  );
}

/* ───────────────────────────── Payments ───────────────────────────── */

const PAYMENT_TABS = [
  { id: "pending" as const, label: "Pending" },
  { id: "overdue" as const, label: "Overdue" },
  { id: "paid" as const, label: "Paid" },
];

export function PaymentsPanel() {
  const [bucket, setBucket] = useState<PaymentFixtureRow["bucket"]>("overdue");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PaymentFixtureRow | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const kebab = useFixtureKebab(show, "Charge");

  const counts = useMemo(() => {
    const c: Record<string, number> = { pending: 0, overdue: 0, paid: 0 };
    for (const r of PAYMENT_ROWS) c[r.bucket] = (c[r.bucket] ?? 0) + 1;
    return c;
  }, []);
  const rows = useMemo(
    () => filterBySearch(PAYMENT_ROWS.filter((r) => r.bucket === bucket).map((r) => ({ ...r, search: `${r.resident} ${r.property}`.toLowerCase() })), search),
    [bucket, search],
  );

  return (
    <ProductWindow path="/portal/payments/incoming/overdue">
      <PortalSidebarFixture active="payments" counts={{ payments: counts.overdue }} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ManagerPortalPageShell title="Payments">
          <PortalListControlStack
            variant="command"
            destinationRow={<FixtureTabs tabs={PAYMENT_TABS.map((t) => ({ ...t, count: counts[t.id], alert: t.id === "overdue" && counts[t.id] > 0 }))} active={bucket} onChange={setBucket} />}
            search={{ value: search, onChange: setSearch, placeholder: "Search payments" }}
            actions={<PortalIconAction icon={Download} label="Export" onClick={() => show("Export")} />}
          />
          <PortalRecordListSurface isEmpty={rows.length === 0} emptyCard={{ title: "No charges here", section: bucket }} bulkActions={kebab}>
            {rows.map((row) => (
              <PortalApplicantRecordRow
                key={row.id}
                name={row.resident}
                address={`${row.chargeTitle} · ${row.property}`}
                facts={<PortalRowFact icon={CalendarDays}>{row.due}</PortalRowFact>}
                amount={row.amount}
                amountTone={row.tone}
                onSelectedChange={() => undefined}
                onOpen={() => setSelected(row)}
                dataAttr="payment-list-row"
              />
            ))}
          </PortalRecordListSurface>
        </ManagerPortalPageShell>
      </div>
      <FixtureSheet
        open={!!selected}
        title={selected?.resident ?? ""}
        onClose={() => setSelected(null)}
        primaryLabel={selected?.bucket === "paid" ? undefined : "Mark paid"}
        onPrimary={() => { show(`${selected?.amount} paid — ${selected?.resident}`); setSelected(null); }}
      >
        {selected ? (
          <>
            <FixtureField label="Charge" value={`${selected.chargeTitle} · ${selected.property}`} />
            <FixtureField label="Due" value={selected.due} />
            <FixtureField label="Amount" value={selected.amount} />
          </>
        ) : null}
      </FixtureSheet>
      {toastNode}
    </ProductWindow>
  );
}

/* ───────────────────────────── Services ───────────────────────────── */

const SERVICE_TABS = [
  { id: "open" as const, label: "Open" },
  { id: "scheduled" as const, label: "Scheduled" },
  { id: "done" as const, label: "Done" },
  { id: "declined" as const, label: "Declined" },
];

export function ServicesPanel() {
  const [state, setState] = useState<ServiceFixtureRow["state"]>("scheduled");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ServiceFixtureRow | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const kebab = useFixtureKebab(show, "Service");

  const counts = useMemo(() => {
    const c: Record<string, number> = { open: 0, scheduled: 0, done: 0, declined: 0 };
    for (const r of SERVICE_ROWS) c[r.state] = (c[r.state] ?? 0) + 1;
    return c;
  }, []);
  const rows = useMemo(
    () => filterBySearch(SERVICE_ROWS.filter((r) => r.state === state).map((r) => ({ ...r, search: `${r.title} ${r.resident} ${r.property}`.toLowerCase() })), search),
    [state, search],
  );

  return (
    <ProductWindow path="/portal/services">
      <PortalSidebarFixture active="services" counts={{ services: counts.open }} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ManagerPortalPageShell title="Services">
          <PortalListControlStack
            variant="command"
            destinationRow={<FixtureTabs tabs={SERVICE_TABS.map((t) => ({ ...t, count: counts[t.id] }))} active={state} onChange={setState} />}
            search={{ value: search, onChange: setSearch, placeholder: "Search services" }}
            actions={<PortalIconAction icon={Settings} label="Settings" onClick={() => show("Settings")} />}
          />
          <PortalRecordListSurface isEmpty={rows.length === 0} emptyCard={{ title: "Nothing here", section: state }} bulkActions={kebab}>
            {rows.map((row) => (
              <PortalServiceRecordRow
                key={row.id}
                title={row.title}
                subtitle={`${row.kind === "add-on" ? "Add-on service" : "Maintenance"} · ${row.property} · ${row.resident} · ${row.detail}`}
                onSelectedChange={() => undefined}
                onOpen={() => setSelected(row)}
                dataAttr="service-list-row"
              />
            ))}
          </PortalRecordListSurface>
        </ManagerPortalPageShell>
      </div>
      <FixtureSheet
        open={!!selected}
        title={selected?.title ?? ""}
        onClose={() => setSelected(null)}
        primaryLabel={selected?.state === "open" ? "Dispatch vendor" : selected?.state === "scheduled" ? "Approve change order" : undefined}
        onPrimary={() => { show(selected?.state === "open" ? "Dispatched — Pacific Plumbing" : "Change order approved — $90"); setSelected(null); }}
      >
        {selected ? (
          <>
            <FixtureField label="Property" value={selected.property} />
            <FixtureField label="Resident" value={selected.resident} />
            <FixtureField label="Detail" value={selected.detail} />
          </>
        ) : null}
      </FixtureSheet>
      {toastNode}
    </ProductWindow>
  );
}

/* ───────────────────────────── Dashboard (hero) ───────────────────────────── */

export function DashboardPanel() {
  const [nowMs] = useState(() => Date.now());
  const propertyCards: PortfolioPropertyCardData[] = DASHBOARD_PROPERTIES.map((p) => ({
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
    <ProductWindow path="/portal/dashboard" fill contentHeight={640}>
      <PortalSidebarFixture active="dashboard" />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
        <p className="mb-3 text-[15px] font-bold text-foreground">Welcome back</p>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="Occupancy" value={DASHBOARD_KPIS.occupancy.value} unit={DASHBOARD_KPIS.occupancy.unit} href="#" dataAttr="dashboard-metric-occupied" />
          <KpiCard label="Rent collected" value={DASHBOARD_KPIS.rentCollected.value} unit={DASHBOARD_KPIS.rentCollected.unit} href="#" dataAttr="dashboard-metric-collected" />
          <KpiCard label="Open requests" value={DASHBOARD_KPIS.openRequests.value} unit={DASHBOARD_KPIS.openRequests.unit} href="#" dataAttr="dashboard-metric-open-requests" />
          <KpiCard label="Applications ready" value={DASHBOARD_KPIS.applicationsReady.value} unit={DASHBOARD_KPIS.applicationsReady.unit} href="#" dataAttr="dashboard-metric-applications" />
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <AttentionPanel rows={DASHBOARD_ATTENTION} />
          <UpcomingPanel rows={DASHBOARD_UPCOMING} nowMs={nowMs} calendarHref="#" />
        </div>
        <PortfolioPropertiesSection cards={propertyCards} basePath="/portal" />
      </div>
    </ProductWindow>
  );
}

/* ───────────────────────────── Switching: import review ───────────────────────────── */

export function ImportReviewPanel() {
  const [proposal, setProposal] = useState(DEMO_IMPORT_SAMPLE);
  const { show, node: toastNode } = useFixtureToast();

  return (
    <ProductWindow path="/portal/properties/import" width={820}>
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
