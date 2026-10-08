"use client";

/**
 * The home demo's three Dashboards (captain 2026-10-07: "the home dashboard must be IDENTICAL to the real
 * dashboard"). Each is drawn by the REAL dashboard's own pieces fed fixture props, never a lookalike:
 *
 * - Manager: `KpiCard` (bars and "vs last month" deltas), `AttentionPanel` fed by the real queue builder,
 *   `UpcomingPanel`, `PortfolioPropertiesSection`, the real cash-flow chart (`MonthlyProfitChart`) and the
 *   "Everything open" box built from the real `AttentionGroup` / `IssueRow` / `StatusPill` exported by
 *   `pro-dashboard.tsx`. The real `ManagerDashboard` also holds its data hooks (session, stores, a fetch for
 *   the chart), so the tree is composed here in the same order and spacing.
 * - Resident: the real `ResidentJourneyBanner`, `ResidentKpiTile` and the Needs attention box's
 *   `AttentionGroup` / `IssueRow` / `StatusPill` from `resident-dashboard.tsx`.
 * - Vendor: the real `VendorDashboardView`, which the real page renders too.
 *
 * Every number is read off the rows the sample world draws on the other tabs (`world.ts`).
 */

import { VendorDashboardBalanceDemo } from "@/components/marketing/site/product-mock/panels-vendor";
import { useMemo, useState, type ReactNode } from "react";
import { ClipboardList, FileSignature, Home, MapPin, MessageSquare, SlidersHorizontal, Users, Wallet, Wrench } from "lucide-react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { ManagerPortalPageShell, PORTAL_DASHBOARD_STACK, PortalDashboardKpiRow } from "@/components/portal/portal-metrics";
import { AttentionPanel, KpiCard, UpcomingPanel, type UpcomingRow } from "@/components/portal/pro-dashboard-kpis";
import { PortfolioPropertiesSection, type PortfolioPropertyCardData } from "@/components/portal/pro-dashboard-portfolio";
import { AttentionGroup, IssueRow, StatusPill } from "@/components/portal/pro-dashboard";
import {
  AttentionGroup as ResidentAttentionGroup,
  IssueRow as ResidentIssueRow,
  ResidentJourneyBanner,
  ResidentKpiTile,
  StatusPill as ResidentStatusPill,
} from "@/components/portal/resident-dashboard";
import { VendorDashboardView } from "@/components/portal/vendor-dashboard";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import { usdWhole } from "@/lib/dashboard-kpis";
import type { MonthlyCashflowPoint } from "@/lib/portal-monthly-profit";
import { residentLifecycleSteps, resolveResidentLifecycleNextAction } from "@/lib/resident-lifecycle-journey";
import { AREA_BY_PROPERTY, COMM_CONVERSATIONS, RESIDENT_HOME, RESIDENT_NAME, PROPERTY_ROWS } from "@/components/marketing/site/product-mock/fixtures";
import { DEMO_PAGE_CLASS, ProductWindow } from "@/components/marketing/site/product-mock/shared";
import {
  residentConversations,
  vendorConversations,
  vendorServices,
  worldFor,
  type DemoStory,
} from "@/components/marketing/site/product-mock/world";
import { phoneScriptFor } from "@/components/marketing/resident-lifecycle-script";
import { MANAGER_DASHBOARD_SECTIONS } from "@/lib/dashboard-preferences";
import { RESIDENT_DASHBOARD_SECTIONS } from "@/lib/resident-dashboard-preferences";
import { DemoCustomizeDashboard } from "@/components/marketing/site/product-mock/demo-popups-lazy-resident";

const NO_OP = () => undefined;

/** Which sections the Customize dashboard pop-up shows: every section at its default, then whatever the visitor toggles. */
function defaultVisibility(sections: ReadonlyArray<{ id: string; defaultVisible: boolean }>): Record<string, boolean> {
  return Object.fromEntries(sections.map((section) => [section.id, section.defaultVisible]));
}

/** A dashboard section the visitor turned off in Customize: out of the layout, like the real dashboard drops it. */
function Visible({ on, children }: { on: boolean; children: ReactNode }) {
  return <div className={on ? "contents" : "hidden"}>{children}</div>;
}

/* ───────────────────────────── Manager ───────────────────────────── */

/** Twelve months of cash flow ending this month: collected rent against expenses, both climbing. */
function cashflowPoints(nowMs: number): MonthlyCashflowPoint[] {
  const revenue = [0, 0, 1650, 3300, 5400, 7100, 9400, 12200, 15500, 19800, 26400, 33900];
  const expense = [0, 0, 0, 900, 1900, 3200, 4600, 6100, 8200, 10700, 12900, 14600];
  const now = new Date(nowMs);
  return revenue.map((value, index) => {
    const at = new Date(now.getFullYear(), now.getMonth() - (revenue.length - 1 - index), 1);
    const monthly = Math.max(0, value - (revenue[index - 1] ?? 0));
    const spent = Math.max(0, expense[index]! - (expense[index - 1] ?? 0));
    return {
      key: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`,
      label: at.toLocaleString("en-US", { month: "short" }),
      revenue: monthly,
      expense: spent,
      profit: monthly - spent,
    };
  });
}

/** Residents with a PropLane login; the rest are drawn "No account yet", as the real group does. */
const ACTIVATED = new Set(["res-liam", "res-priya", "res-maya"]);

const placeLine = (place: string) => place;

export function ManagerDashboardView({ story }: { story?: DemoStory }) {
  const [customizing, setCustomizing] = useState(false);
  const [vis, setVis] = useState(() => defaultVisibility(MANAGER_DASHBOARD_SECTIONS));
  const [nowMs] = useState(() => Date.now());
  const world = worldFor(story);
  const { dashboard } = world;
  const points = useMemo(() => cashflowPoints(nowMs), [nowMs]);
  const labels = useMemo(
    () => Array.from({ length: 8 }, (_, index) => new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth() - (7 - index), 1).toLocaleString("en-US", { month: "short" })),
    [nowMs],
  );

  const cards: PortfolioPropertyCardData[] = dashboard.properties.map((p) => ({
    key: p.id,
    stage: "listed",
    title: p.title,
    address: p.address,
    spacesLabel: p.spacesLabel,
    spaces: Number(p.spacesLabel.split(" ")[0]) || 1,
    rentLabel: p.rentLabel,
    coverUrl: null,
  }));
  const currentResidents = world.residents.filter((r) => r.tab === "current");
  const occupiedByProperty = new Map<string, number>(
    PROPERTY_ROWS.map((p) => [p.id, currentResidents.filter((r) => r.place.includes(p.title)).length]),
  );

  const pendingTours = world.tours.filter((t) => t.bucket === "pending");
  const pendingApps = world.applications.filter((a) => a.bucket === "pending");
  const toSign = world.leases.filter((l) => l.bucket === "signed");
  const charges = world.payments.filter((p) => p.bucket === "pending" || p.bucket === "overdue");
  const overdueCount = charges.filter((p) => p.bucket === "overdue").length;
  const services = world.services.filter((s) => s.state === "open" || s.state === "scheduled");
  const unread = COMM_CONVERSATIONS.filter((c) => c.segment === "active" && c.unread);
  const openCount = pendingTours.length + pendingApps.length + toSign.length + currentResidents.length + charges.length + services.length + unread.length;

  const rentOf = (place: string) => PROPERTY_ROWS.find((p) => place.includes(p.title))?.rentLabel.replace("/mo", " / month");

  return (
    <ProductWindow path="/portal/dashboard" nativeHeight={900}>
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title="Dashboard" navigationProvidesTitle>
          <div className={`min-w-0 ${PORTAL_DASHBOARD_STACK}`}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard
                label="Occupancy"
                value={dashboard.occupancy.value}
                unit={dashboard.occupancy.unit}
                delta={dashboard.occupancy.delta ?? null}
                series={dashboard.occupancy.series}
                seriesLabels={labels}
                format={(n) => `${n}%`}
                href="#"
                dataAttr="dashboard-metric-occupied"
              />
              <KpiCard
                label="Rent collected"
                value={dashboard.rentCollected.value}
                unit={dashboard.rentCollected.unit}
                delta={dashboard.rentCollected.delta ?? null}
                series={dashboard.rentCollected.series}
                seriesLabels={labels}
                format={usdWhole}
                href="#"
                dataAttr="dashboard-metric-collected"
              />
              <KpiCard
                label="Open requests"
                value={dashboard.openRequests.value}
                unit={dashboard.openRequests.unit}
                delta={dashboard.openRequests.delta ?? null}
                series={dashboard.openRequests.series}
                seriesLabels={labels}
                format={String}
                href="#"
                dataAttr="dashboard-metric-requests"
              />
              <KpiCard
                label="Applications ready"
                value={dashboard.applicationsReady.value}
                unit={dashboard.applicationsReady.unit}
                delta={null}
                href="#"
                dataAttr="dashboard-metric-applications"
              />
            </div>

            <div className="grid items-stretch gap-4 lg:grid-cols-2">
              <AttentionPanel rows={dashboard.attention} />
              <UpcomingPanel rows={dashboard.upcoming as UpcomingRow[]} nowMs={nowMs} calendarHref="#" />
            </div>

            <PortfolioPropertiesSection
              cards={cards}
              basePath="/portal"
              occupiedByProperty={occupiedByProperty}
              addPropertyAction={<PortalPrimaryIconAction label="Create" data-attr="dashboard-create" onClick={NO_OP} />}
            />

            <div data-dashboard-section="cashflow" className={vis.cashflow ? undefined : "hidden"}>
              <MonthlyProfitChart points={points} />
            </div>

            <section className="overflow-hidden rounded-[10px] border border-border bg-card" data-attr="dashboard-everything-open">
              <div className="flex items-center gap-2 border-b border-border px-3.5 py-[11px]">
                <h2 className="min-w-0 truncate text-sm font-[650] text-foreground">Everything open</h2>
                {openCount > 0 ? <span className="text-[12.5px] font-medium tabular-nums text-muted/70">{openCount}</span> : null}
                <PortalIconAction icon={SlidersHorizontal} label="Customize" onClick={() => setCustomizing(true)} data-attr="dashboard-customize-open" className="ml-auto" />
              </div>

              <div data-dashboard-section="tours" className={`border-b border-border last:border-b-0${vis.tours ? "" : " hidden"}`}>
                <AttentionGroup
                  title="Tour requests"
                  href="#"
                  sectionId="tours"
                  icon={MapPin}
                  tone="pending"
                  order={0}
                  items={pendingTours}
                  emptyMessage="No pending tour requests right now."
                  keyForItem={(tour) => tour.id}
                  renderRow={(tour, tone) => (
                    <IssueRow
                      href="#"
                      tone={tone}
                      title={tour.guest}
                      subtitle={tour.place}
                      meta={tour.when}
                      pill={<StatusPill tone={tone}>Pending</StatusPill>}
                      dataAttr="dashboard-attention-tour"
                    />
                  )}
                />
              </div>
              <div data-dashboard-section="applications" className={`border-b border-border last:border-b-0${vis.applications ? "" : " hidden"}`}>
                <AttentionGroup
                  title="Applications to approve"
                  href="#"
                  sectionId="applications"
                  icon={ClipboardList}
                  tone="pending"
                  order={1}
                  items={pendingApps}
                  emptyMessage="No applications waiting for your review."
                  keyForItem={(app) => app.id}
                  renderRow={(app, tone) => (
                    <IssueRow
                      href="#"
                      tone={tone}
                      title={app.name}
                      subtitle={app.property}
                      pill={<StatusPill tone={tone}>Submitted</StatusPill>}
                      dataAttr="dashboard-attention-application"
                    />
                  )}
                />
              </div>
              <div data-dashboard-section="leases" className={`border-b border-border last:border-b-0${vis.leases ? "" : " hidden"}`}>
                <AttentionGroup
                  title="Leases to sign"
                  href="#"
                  sectionId="leases"
                  icon={FileSignature}
                  tone="pending"
                  order={2}
                  items={toSign}
                  emptyMessage="No leases waiting for a signature."
                  keyForItem={(lease) => lease.id}
                  renderRow={(lease, tone) => (
                    <IssueRow
                      href="#"
                      tone={tone}
                      title={lease.resident}
                      subtitle={placeLine(lease.place)}
                      meta={rentOf(lease.place)}
                      pill={<StatusPill tone={tone}>Your signature</StatusPill>}
                      dataAttr="dashboard-attention-lease"
                    />
                  )}
                />
              </div>
              <div data-dashboard-section="residents" className={`border-b border-border last:border-b-0${vis.residents ? "" : " hidden"}`}>
                <AttentionGroup
                  title="Residents"
                  href="#"
                  sectionId="residents"
                  icon={Users}
                  tone={currentResidents.every((r) => ACTIVATED.has(r.id)) ? "success" : "pending"}
                  order={3}
                  items={currentResidents}
                  emptyMessage="No current residents yet."
                  keyForItem={(resident) => resident.id}
                  renderRow={(resident) => {
                    const activated = ACTIVATED.has(resident.id);
                    const tone = activated ? "success" : "pending";
                    return (
                      <IssueRow
                        href="#"
                        tone={tone}
                        title={resident.name}
                        subtitle={placeLine(resident.place)}
                        meta={rentOf(resident.place)}
                        pill={<StatusPill tone={tone}>{activated ? "Activated" : "No account yet"}</StatusPill>}
                        dataAttr="dashboard-attention-resident"
                      />
                    );
                  }}
                />
              </div>
              <div data-dashboard-section="payments" className={`border-b border-border last:border-b-0${vis.payments ? "" : " hidden"}`}>
                <AttentionGroup
                  title="Payments"
                  href="#"
                  sectionId="payments"
                  icon={Wallet}
                  tone={overdueCount > 0 ? "danger" : "pending"}
                  order={4}
                  badge={
                    charges.length > 0 ? (
                      <span className="flex flex-wrap items-center gap-2">
                        {charges.length - overdueCount > 0 ? <StatusPill tone="pending">{charges.length - overdueCount} pending</StatusPill> : null}
                        {overdueCount > 0 ? <StatusPill tone="danger">{overdueCount} overdue</StatusPill> : null}
                      </span>
                    ) : null
                  }
                  items={charges}
                  emptyMessage="No pending or overdue payments right now."
                  keyForItem={(charge) => charge.id}
                  renderRow={(charge) => {
                    const overdue = charge.bucket === "overdue";
                    const tone = overdue ? "danger" : "pending";
                    return (
                      <IssueRow
                        href="#"
                        tone={tone}
                        title={charge.resident}
                        subtitle={`${charge.chargeTitle} · ${charge.due}`}
                        meta={charge.amount}
                        pill={<StatusPill tone={tone}>{overdue ? "Overdue" : "Pending"}</StatusPill>}
                        dataAttr="dashboard-attention-payment"
                      />
                    );
                  }}
                />
              </div>
              <div data-dashboard-section="services" className={`border-b border-border last:border-b-0${vis.services ? "" : " hidden"}`}>
                <AttentionGroup
                  title="Services needed"
                  href="#"
                  sectionId="services"
                  icon={Wrench}
                  tone="pending"
                  order={5}
                  items={services}
                  emptyMessage="No open or scheduled services right now."
                  keyForItem={(service) => service.id}
                  renderRow={(service) => (
                    <IssueRow
                      href="#"
                      tone={service.state === "open" ? "danger" : "pending"}
                      title={service.title}
                      subtitle={service.property}
                      pill={<StatusPill tone={service.state === "open" ? "danger" : "pending"}>{service.state === "open" ? "Open" : "Scheduled"}</StatusPill>}
                      dataAttr="dashboard-attention-service"
                    />
                  )}
                />
              </div>
              <div data-dashboard-section="inbox" className={`border-b border-border last:border-b-0${vis.inbox ? "" : " hidden"}`}>
                <AttentionGroup
                  title="Unread messages"
                  href="#"
                  sectionId="inbox"
                  icon={MessageSquare}
                  tone="danger"
                  order={6}
                  headerCount={unread.length}
                  items={unread}
                  emptyMessage="No unread messages. Communication is clear."
                  keyForItem={(thread) => thread.id}
                  renderRow={(thread, tone) => (
                    <IssueRow
                      href="#"
                      tone={tone}
                      title={thread.name}
                      subtitle={thread.preview}
                      pill={<StatusPill tone={tone}>Unread</StatusPill>}
                      dataAttr="dashboard-attention-inbox"
                    />
                  )}
                />
              </div>
            </section>
          </div>
        </ManagerPortalPageShell>
      </div>
      {customizing ? (
        <DemoCustomizeDashboard
          role="manager"
          visibility={vis}
          onToggle={(id, visible) => setVis((current) => ({ ...current, [id]: visible }))}
          onReset={() => setVis(defaultVisibility(MANAGER_DASHBOARD_SECTIONS))}
          onClose={() => setCustomizing(false)}
        />
      ) : null}
    </ProductWindow>
  );
}

/* ───────────────────────────── Resident ───────────────────────────── */

export function ResidentDashboardView({ story, stage }: { story: DemoStory; stage?: string }) {
  const [customizing, setCustomizing] = useState(false);
  const [vis, setVis] = useState(() => defaultVisibility(RESIDENT_DASHBOARD_SECTIONS));
  const unread = residentConversations(story, phoneScriptFor("resident", stage ?? "pay").items).filter((c) => c.segment === "active" && c.unread);
  const leaseSigned = story.leaseStep === 3;
  const residentSigned = story.leaseStep >= 2;
  const rentDue = leaseSigned && !story.rentPaid;
  const openService = story.service === "open" || story.service === "quoted" || story.service === "scheduled";
  const pendingTour = story.tourOffered && !story.tourAccepted;
  const pendingApplication = story.applicationSubmitted && !story.applicationApproved;

  const input = {
    applicationFeePaid: true,
    applicationSubmitted: story.applicationSubmitted,
    applicationApproved: story.applicationApproved,
    residentSignedLease: residentSigned,
    managerCountersigned: leaseSigned,
    moveInChargesPaid: residentSigned && story.rentPaid,
    movedIn: leaseSigned && story.rentPaid,
    basePath: "/resident",
    moveInTotalLabel: rentDue ? "$1,080.00" : undefined,
  };
  const steps = residentLifecycleSteps(input);
  const action = resolveResidentLifecycleNextAction(input);

  const showTourKpi = !story.applicationApproved;
  const showApplicationKpi = !story.applicationApproved;
  const showLeaseKpi = story.applicationApproved && !leaseSigned;
  const openCount =
    (pendingTour ? 1 : 0) + (pendingApplication ? 1 : 0) + (story.applicationApproved ? 1 : 0) + (leaseSigned ? 1 : 0) + (openService ? 1 : 0) + (rentDue ? 1 : 0) + unread.length;

  return (
    <ProductWindow path="/resident/dashboard" nativeHeight={900}>
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title={leaseSigned ? `Welcome home, ${RESIDENT_NAME}.` : `Welcome, ${RESIDENT_NAME}.`} hideTitleOnNative hideTitleOnMobileNav>
          <div className={`min-w-0 ${PORTAL_DASHBOARD_STACK}`}>
            <ResidentJourneyBanner steps={steps} action={action} />
            {leaseSigned ? (
              <a
                href="#"
                onClick={(event) => event.preventDefault()}
                data-attr="resident-dashboard-move-in-hero"
                className="flex w-full items-center justify-between gap-3 rounded-[10px] border border-primary/20 bg-accent px-4 py-3.5 transition-colors hover:border-primary/40"
              >
                <span className="min-w-0">
                  <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">Your home</span>
                  <span className="mt-0.5 block truncate text-lg font-semibold text-foreground">{RESIDENT_HOME.property}</span>
                </span>
                <span aria-hidden className="shrink-0 text-lg text-primary">
                  ›
                </span>
              </a>
            ) : null}
            <PortalDashboardKpiRow>
              {showTourKpi ? (
                <ResidentKpiTile label="Tour pending" value={pendingTour ? 1 : 0} tone={pendingTour ? "warning" : "neutral"} href="#" dataAttr="resident-dashboard-kpi-tour-pending" />
              ) : null}
              {showApplicationKpi ? (
                <ResidentKpiTile
                  label="Application pending"
                  value={pendingApplication ? 1 : 0}
                  tone={pendingApplication ? "warning" : "neutral"}
                  href="#"
                  dataAttr="resident-dashboard-kpi-application-pending"
                />
              ) : null}
              {showLeaseKpi ? (
                <ResidentKpiTile label="Lease" value={story.leaseStep === 1 ? 1 : 0} tone={story.leaseStep === 1 ? "warning" : "neutral"} href="#" dataAttr="resident-dashboard-kpi-lease" />
              ) : null}
              {leaseSigned ? (
                <ResidentKpiTile label="Services" value={openService ? 1 : 0} tone={openService ? "warning" : "neutral"} href="#" dataAttr="resident-dashboard-kpi-services" />
              ) : null}
              {story.applicationApproved ? (
                <div className="plp-stats">
                  <ResidentKpiTile
                    label="Balance due"
                    value={rentDue ? "$1,080.00" : "$0.00"}
                    tone={rentDue ? "warning" : "neutral"}
                    href="#"
                    dataAttr="resident-dashboard-kpi-balance"
                  />
                </div>
              ) : null}
              {unread.length > 0 ? (
                <ResidentKpiTile label="Unread messages" value={unread.length} tone="warning" href="#" dataAttr="resident-dashboard-kpi-inbox" />
              ) : null}
            </PortalDashboardKpiRow>

            <section className="overflow-hidden rounded-[10px] border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-3.5 py-[11px]">
                <h2 className="min-w-0 truncate text-sm font-[650] text-foreground">Needs attention</h2>
                {openCount > 0 ? <span className="text-[12.5px] font-medium tabular-nums text-muted/70">{openCount}</span> : null}
                <PortalIconAction icon={SlidersHorizontal} label="Customize" onClick={() => setCustomizing(true)} data-attr="resident-dashboard-customize-open" className="ml-auto" />
              </div>

              <Visible on={vis.tours}>
              <ResidentAttentionGroup
                title="Tour pending"
                href="#"
                sectionId="tours"
                icon={MapPin}
                tone="pending"
                items={pendingTour ? [{ id: "tour" }] : []}
                emptyMessage="No pending tour requests."
                keyForItem={(item) => item.id}
                renderRow={(_item, tone) => (
                  <ResidentIssueRow
                    href="#"
                    tone={tone}
                    title={`${RESIDENT_HOME.property}`}
                    subtitle="Thu, 5:30 PM"
                    pill={<ResidentStatusPill tone="pending">Pending</ResidentStatusPill>}
                    dataAttr="resident-dashboard-attention-tour"
                  />
                )}
              />
              </Visible>
              <Visible on={vis.applications}>
              <ResidentAttentionGroup
                title="Application pending"
                href="#"
                sectionId="applications"
                icon={ClipboardList}
                tone="pending"
                items={pendingApplication ? [{ id: "application" }] : []}
                emptyMessage="No pending applications."
                keyForItem={(item) => item.id}
                renderRow={(_item, tone) => (
                  <ResidentIssueRow
                    href="#"
                    tone={tone}
                    title={RESIDENT_HOME.property}
                    subtitle={RESIDENT_HOME.room}
                    pill={<ResidentStatusPill tone="pending">Documents complete</ResidentStatusPill>}
                    dataAttr="resident-dashboard-attention-application"
                  />
                )}
              />
              </Visible>
              <Visible on={vis.lease}>
              <ResidentAttentionGroup
                title="Lease"
                href="#"
                sectionId="lease"
                icon={FileSignature}
                tone="info"
                items={story.applicationApproved ? [{ id: "lease" }] : []}
                emptyMessage="Available after your application is approved."
                keyForItem={(item) => item.id}
                renderRow={() => {
                  const sign = story.leaseStep === 1;
                  const label = leaseSigned ? "Active ✓" : residentSigned ? "Awaiting manager" : sign ? "Sign now" : "Not started";
                  return (
                    <ResidentIssueRow
                      href="#"
                      tone={leaseSigned ? "success" : sign ? "info" : "pending"}
                      title={sign ? "Signature needed" : leaseSigned ? "Lease active" : "Lease status"}
                      subtitle={`${RESIDENT_HOME.property} · ${RESIDENT_HOME.room}`}
                      meta={`${RESIDENT_HOME.rent}.00/mo`}
                      pill={<ResidentStatusPill tone={leaseSigned ? "success" : sign ? "info" : residentSigned ? "info" : "neutral"}>{label}</ResidentStatusPill>}
                      dataAttr="resident-dashboard-attention-lease"
                    />
                  );
                }}
              />
              </Visible>
              <Visible on={vis.houseDetails}>
              <ResidentAttentionGroup
                title="House details"
                href="#"
                sectionId="houseDetails"
                icon={Home}
                tone="info"
                items={leaseSigned ? [{ id: "house-details" }] : []}
                emptyMessage="Open house details for move-in placement and keys."
                keyForItem={(item) => item.id}
                renderRow={() => (
                  <ResidentIssueRow
                    href="#"
                    tone="info"
                    title="House details"
                    subtitle={`${RESIDENT_HOME.property} · ${RESIDENT_HOME.room}`}
                    pill={<ResidentStatusPill tone="success">Ready</ResidentStatusPill>}
                    dataAttr="resident-dashboard-attention-house-details"
                  />
                )}
              />
              </Visible>
              {leaseSigned ? (
                <Visible on={vis.services}>
                <ResidentAttentionGroup
                  title="Services"
                  href="#"
                  sectionId="services"
                  icon={Wrench}
                  tone="pending"
                  items={openService ? [{ id: "faucet" }] : []}
                  emptyMessage="No open services right now."
                  keyForItem={(item) => item.id}
                  renderRow={(_item, tone) => (
                    <ResidentIssueRow
                      href="#"
                      tone={tone}
                      title="Kitchen faucet"
                      subtitle={`${RESIDENT_HOME.property} · ${RESIDENT_HOME.room}`}
                      pill={<ResidentStatusPill tone="pending">{story.service === "scheduled" ? "Scheduled" : "Open"}</ResidentStatusPill>}
                      dataAttr="resident-dashboard-attention-service"
                    />
                  )}
                />
                </Visible>
              ) : null}
              {story.applicationApproved ? (
                <Visible on={vis.payments}>
                <ResidentAttentionGroup
                  title="Pending & overdue payments"
                  href="#"
                  sectionId="payments"
                  icon={Wallet}
                  tone="pending"
                  items={rentDue ? [{ id: "rent" }] : []}
                  emptyMessage={leaseSigned ? "No outstanding charges." : "Payments will appear here after your application is approved and your lease is signed."}
                  keyForItem={(item) => item.id}
                  renderRow={(_item, tone) => (
                    <ResidentIssueRow
                      href="#"
                      tone={tone}
                      title="October rent"
                      subtitle="Due Oct 1"
                      meta="$1,080.00"
                      pill={<ResidentStatusPill tone="pending">Pending</ResidentStatusPill>}
                      dataAttr="resident-dashboard-attention-payment"
                    />
                  )}
                />
                </Visible>
              ) : null}
              <Visible on={vis.communication}>
              <ResidentAttentionGroup
                title="Communication"
                href="#"
                sectionId="communication"
                icon={MessageSquare}
                tone="info"
                headerCount={unread.length}
                items={unread}
                emptyMessage="No unread messages. Communication is clear."
                keyForItem={(thread) => thread.id}
                renderRow={(thread, tone) => (
                  <ResidentIssueRow
                    href="#"
                    tone={tone}
                    title={thread.name}
                    subtitle={thread.preview}
                    pill={<ResidentStatusPill tone="info">Unread</ResidentStatusPill>}
                    dataAttr="resident-dashboard-attention-inbox"
                  />
                )}
              />
              </Visible>
            </section>
          </div>
        </ManagerPortalPageShell>
      </div>
      {customizing ? (
        <DemoCustomizeDashboard
          role="resident"
          leaseSigned={leaseSigned}
          visibility={vis}
          onToggle={(id, visible) => setVis((current) => ({ ...current, [id]: visible }))}
          onReset={() => setVis(defaultVisibility(RESIDENT_DASHBOARD_SECTIONS))}
          onClose={() => setCustomizing(false)}
        />
      ) : null}
    </ProductWindow>
  );
}

/* ───────────────────────────── Vendor ───────────────────────────── */

export function VendorDashboardDemo({ story, stage }: { story: DemoStory; stage?: string }) {
  const [nowMs] = useState(() => Date.now());
  const jobs = vendorServices(story);
  const open = jobs.filter((job) => job.state !== "completed");
  const bids = open.filter((job) => !job.hired);
  const visits = jobs.filter((job) => job.state === "scheduled");
  const unread = vendorConversations(phoneScriptFor("vendor", stage ?? "visit").items).filter((c) => c.segment === "active" && c.unread);

  // A vendor who is not hired yet sees the general area only, never the street or the house (same rule as the Services tab).
  const propertyLabel = (job: (typeof jobs)[number]) => {
    if (!job.hired) return AREA_BY_PROPERTY[job.property] ?? "Seattle";
    return job.unit ? `${job.property} · ${job.unit}` : job.property;
  };
  const attention = [
    ...(bids.length > 0
      ? [
          {
            id: "bids",
            title: `${bids.length} ${bids.length === 1 ? "job" : "jobs"} waiting on a bid`,
            detail: propertyLabel(bids[0]!),
            actionLabel: "Continue" as const,
            href: "#",
            tone: "pending" as const,
          },
        ]
      : []),
    ...(unread.length > 0
      ? [
          {
            id: "inbox",
            title: `${unread.length} unread ${unread.length === 1 ? "message" : "messages"}`,
            detail: unread[0]!.name,
            actionLabel: "Reply" as const,
            href: "#",
            tone: "info" as const,
          },
        ]
      : []),
  ];
  const upcoming: UpcomingRow[] = visits.map((job, index) => ({
    id: `visit-${job.id}`,
    kind: "Visit",
    title: job.title,
    detail: propertyLabel(job),
    at: new Date(nowMs).setHours(9, 0, 0, 0) + (index + 1) * 24 * 60 * 60 * 1000,
    href: "#",
  }));

  return (
    <ProductWindow path="/vendor/dashboard" nativeHeight={900}>
      <div className={DEMO_PAGE_CLASS}>
        <VendorDashboardView
          openJobs={open.length}
          bidsDue={bids.length}
          upcomingVisits={visits.length}
          unreadMessages={unread.length}
          nextVisitLabel={upcoming[0] ? "Next: Tomorrow 9:00 AM" : undefined}
          attentionRows={attention}
          upcomingRows={upcoming}
          nowMs={nowMs}
          jobs={open.slice(0, 3).map((job) => ({
            id: job.id,
            title: job.title,
            subtitle: propertyLabel(job),
            bidNeeded: !job.hired,
            scheduledLabel: job.fact,
          }))}
          onAdd={NO_OP}
          onOpenJob={NO_OP}
          belowKpis={<VendorDashboardBalanceDemo story={story} />}
        />
      </div>
    </ProductWindow>
  );
}
