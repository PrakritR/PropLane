import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import {
  AttentionPanel,
  KpiCard,
  UpcomingPanel,
} from "@/components/portal/pro-dashboard-kpis";
import { HomeDashboardTour } from "./home-dashboard-tour";
import { homeRentPaid } from "./home-dashboard-data";
import { DEMO_TABS } from "./site/product-mock/demo-nav";
import { residentStory, worldFor } from "./site/product-mock/world";
import "./home-dashboard-stage.css";

// The bundled sample calendar is created when its fixture module loads.
const SAMPLE_NOW_MS = Date.now();

/** One real dashboard composition, rendered on the server even without motion or JavaScript. */
export function HomeDashboardStage() {
  const world = worldFor(residentStory("pay"));
  const { dashboard } = world;
  const paid = homeRentPaid();
  const attention = dashboard.attention
    .slice(0, 4)
    .map((row) => ({ ...row, href: "#dashboard" }));
  const upcoming = dashboard.upcoming
    .slice(0, 4)
    .map((row) => ({ ...row, href: "#dashboard" }));
  const tabs = DEMO_TABS.manager.filter((tab) =>
    [
      "dashboard",
      "properties",
      "communication",
      "residents",
      "applications",
      "services",
      "payments",
      "calendar",
    ].includes(tab.id),
  );
  const metrics = [
    {
      id: "occupied",
      label: "Occupancy",
      ...dashboard.occupancy,
      beat: "rentals",
    },
    {
      id: "collected",
      label: "Rent collected",
      ...dashboard.rentCollected,
      beat: "payments",
    },
    {
      id: "requests",
      label: "Open requests",
      value: dashboard.openRequests.value,
      beat: "services",
    },
    {
      id: "applications",
      label: "Applications ready",
      ...dashboard.applicationsReady,
      beat: "rentals",
    },
  ];
  return (
    <HomeDashboardTour>
      <div className="home-dashboard-overview" data-home-dashboard-window>
        <div className="home-dashboard-preview" inert aria-hidden="true">
          <aside className="home-dashboard-sidebar">
            <div className="home-dashboard-brand">
              <ProPlaneMarkIcon />
              PropLane
            </div>
            <div className="home-dashboard-workspace">
              All houses <span>{world.properties.length}</span>
            </div>
            <div className="home-dashboard-nav">
              {tabs.map((tab) => (
                <div key={tab.id} data-current={tab.id === "dashboard"}>
                  <PortalNavIcon section={tab.id} />
                  <span>{tab.label}</span>
                </div>
              ))}
            </div>
            <span className="home-dashboard-account">Property manager</span>
          </aside>
          <div className="home-dashboard-main">
            <h3>Dashboard</h3>
            <div className="home-dashboard-metrics">
              {metrics.map((metric) => (
                <div
                  key={metric.id}
                  className="home-dashboard-highlight"
                  data-dashboard-beat={metric.beat}
                >
                  <KpiCard
                    label={metric.label}
                    value={metric.value}
                    unit={"unit" in metric ? metric.unit : undefined}
                    href="#dashboard"
                    dataAttr={`dashboard-metric-${metric.id}`}
                  />
                </div>
              ))}
            </div>
            <div className="home-dashboard-columns">
              <div
                className="home-dashboard-highlight home-dashboard-attention"
                data-dashboard-beat="rentals"
              >
                <AttentionPanel rows={attention} />
              </div>
              <div
                className="home-dashboard-highlight home-dashboard-upcoming"
                data-dashboard-beat="services"
              >
                <UpcomingPanel
                  rows={upcoming}
                  nowMs={SAMPLE_NOW_MS}
                  calendarHref="#dashboard"
                  aside={null}
                />
              </div>
            </div>
          </div>
        </div>
        <p className="home-dashboard-receipt" data-payment-id={paid.id}>
          <span aria-hidden="true">✓</span>
          <span>
            <strong>Rent received</strong> · {paid.amount}
            <small>
              {paid.property} · {paid.chargeTitle}
            </small>
          </span>
        </p>
      </div>
      <div className="sr-only" aria-label="Sample dashboard records">
        <dl>
          {metrics.map((metric) => (
            <div key={metric.id}>
              <dt>{metric.label}</dt>
              <dd>
                {metric.value}
                {"unit" in metric && metric.unit ? ` · ${metric.unit}` : ""}
              </dd>
            </div>
          ))}
        </dl>
        <h3>Needs attention</h3>
        <ul>
          {attention.map((row) => (
            <li key={row.id}>{row.title}</li>
          ))}
        </ul>
        <h3>Upcoming</h3>
        <ul>
          {upcoming.map((row) => (
            <li key={row.id}>
              {row.kind} · {row.title} · {row.detail}
            </li>
          ))}
        </ul>
      </div>
    </HomeDashboardTour>
  );
}
