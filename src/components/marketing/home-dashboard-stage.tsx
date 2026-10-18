import { HomeDashboardTour } from "./home-dashboard-tour";
import { HomeDashboardDeferred } from "./home-dashboard-deferred";
import { HOME_DASHBOARD_PORTALS, homeRentPaid, type HomeDashboardPortal } from "./home-dashboard-data";
import { homeOwnerStatements } from "./home-dashboard-owner-data";
import { RESIDENT_HOME } from "./site/product-mock/fixtures";
import { residentStory, vendorServices, vendorStory, worldFor } from "./site/product-mock/world";
import "./home-dashboard-stage.css";

function PortalSummary({ portal }: { portal: HomeDashboardPortal }) {
  const world = worldFor(residentStory("pay"));
  const owner = homeOwnerStatements();
  return <div className="home-dashboard-snapshot" aria-label={`${portal} sample records`}>
    <span>Sample data</span>
    <h3>{HOME_DASHBOARD_PORTALS.find((item) => item.id === portal)!.label}</h3>
    {portal === "manager" ? <><dl><div><dt>Occupancy</dt><dd>{world.dashboard.occupancy.unit}</dd></div><div><dt>Rent collected</dt><dd>{world.dashboard.rentCollected.value}</dd></div></dl><ul>{world.dashboard.attention.map((row) => <li key={row.id}>{row.title}</li>)}</ul></>
      : portal === "resident" ? <><h4>My home</h4><p>{RESIDENT_HOME.property} · {RESIDENT_HOME.room}</p><p>{homeRentPaid().chargeTitle} · {homeRentPaid().amount} · Paid</p></>
        : portal === "vendor" ? <><h4>Services</h4><ul>{vendorServices(vendorStory("visit")).map((row) => <li key={row.id}>{row.title} · {row.property}</li>)}</ul></>
          : <><h4>Statements</h4><p>September 2025</p><ul>{owner.houses.map((house) => <li key={house.propertyId}>{house.label}</li>)}</ul><p>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(owner.rows[0].distributionCents / 100)}</p></>}
  </div>;
}

export function HomeDashboardStage() {
  return <HomeDashboardTour steps={HOME_DASHBOARD_PORTALS.map((portal) => ({ ...portal, content: <HomeDashboardDeferred key={portal.id} portal={portal.id} fallback={<PortalSummary portal={portal.id} />} /> }))} />;
}
