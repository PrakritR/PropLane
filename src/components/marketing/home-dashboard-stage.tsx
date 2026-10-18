import { HomeScrollStage } from "./home-scroll-stage";
import { HomeDashboardDeferred } from "./home-dashboard-deferred";
import {
  HOME_DASHBOARD_TABS,
  homeDashboardRows,
  homeRentPaid,
} from "./home-dashboard-data";
import { MobileAppPreview } from "./mobile-app-preview";
import { RESIDENT_HOME } from "./site/product-mock/fixtures";
import {
  RecordFactCard,
  RecordFactRow,
  StatTile,
} from "@/components/portal/portal-record-overview-kit";
import "./home-dashboard-stage.css";

/** Fixture markup is available before JavaScript and while a real panel's chunk loads. */
function PanelSnapshot({ tab }: { tab: (typeof HOME_DASHBOARD_TABS)[number] }) {
  const rows = homeDashboardRows(tab.id);
  return (
    <div
      className="home-dashboard-snapshot"
      aria-label={`${tab.label} sample records`}
    >
      <header>
        <span>PropLane</span>
        <span>Sample workspace</span>
      </header>
      <div className="home-dashboard-snapshot-body">
        <h3>{tab.label}</h3>
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <div>
                <strong>{row.title}</strong>
                <span>{row.place}</span>
                <p>{row.detail}</p>
              </div>
              <span>{row.figure}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function HomeDashboardStage() {
  const paid = homeRentPaid();
  const steps = HOME_DASHBOARD_TABS.map((tab) => ({
    ...tab,
    content: (
      <HomeDashboardDeferred
        tab={tab.id}
        fallback={<PanelSnapshot tab={tab} />}
      />
    ),
  }));
  return (
    <HomeScrollStage
      id="dashboard"
      title={
        <>
          <span>Everything the number does,</span> on one screen.
        </>
      }
      className="home-dashboard-tour"
      layout="wide"
      travel={600}
      steps={[
        ...steps,
        {
          id: "phone-notification",
          label: "Your phone",
          caption: "And on your phone.",
          content: (
            <div
              className="home-dashboard-phone"
              aria-label="Manager’s phone: sample notification"
            >
              <MobileAppPreview>
                <div className="home-dashboard-phone-content">
                  <span>PropLane</span>
                  <h3>Communication</h3>
                  <article className="home-dashboard-notification">
                    <strong>{RESIDENT_HOME.room} asked about a tour.</strong>
                    <p>Reply drafted.</p>
                  </article>
                  <p>PropLane drafts the reply. You approve it.</p>
                </div>
              </MobileAppPreview>
            </div>
          ),
        },
        {
          id: "phone-paid",
          label: "Paid",
          caption: "Paid.",
          content: (
            <div
              className="home-dashboard-phone"
              aria-label="Manager’s phone: sample rent payment"
            >
              <MobileAppPreview>
                <div className="home-dashboard-phone-content">
                  <span>PropLane</span>
                  <h3>Payments</h3>
                  <div
                    className="home-dashboard-payment"
                    data-payment-id={paid.id}
                  >
                    <div className="grid grid-cols-2 gap-2">
                      <StatTile
                        label="Amount"
                        value={paid.amount}
                        dataAttr="payment-overview-tile-amount"
                      />
                      <StatTile
                        label="Status"
                        value="Paid"
                        dataAttr="payment-overview-tile-status"
                      />
                    </div>
                    <RecordFactCard
                      title="Details"
                      dataAttr="payment-overview-card-details"
                    >
                      <RecordFactRow label="Resident" value={paid.resident} />
                      <RecordFactRow label="Property" value={paid.property} />
                      <RecordFactRow label="Charge" value={paid.chargeTitle} />
                      <RecordFactRow
                        label="Paid on"
                        value={paid.due.replace(/^Paid\s+/, "")}
                      />
                    </RecordFactCard>
                  </div>
                </div>
              </MobileAppPreview>
            </div>
          ),
        },
      ]}
    />
  );
}
