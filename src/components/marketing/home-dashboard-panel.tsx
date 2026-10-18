"use client";

import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { ResidentLifecycleWorkspace } from "./resident-lifecycle-workspace";
import { DEMO_TABS } from "./site/product-mock/demo-nav";
import { BarePanelChrome, InertDemoLinks } from "./site/product-mock/shared";
import { homeDashboardStory, HOME_DASHBOARD_TABS, type HomeDashboardTab } from "./home-dashboard-data";
import "./resident-lifecycle-prototypes.css";

const Inbox = lazy(() => import("./home-dashboard-inbox"));
const Applications = lazy(() => import("./site/product-mock/panels").then((module) => ({ default: module.ApplicationsPanel })));
const Leases = lazy(() => import("./site/product-mock/panels").then((module) => ({ default: module.LeasesPanel })));
const Services = lazy(() => import("./site/product-mock/panels-manager-money").then((module) => ({ default: module.ServicesPanel })));
const Bookings = lazy(() => import("./site/product-mock/panels-manager-rest").then((module) => ({ default: module.BookingsPanel })));
const Payments = lazy(() => import("./site/product-mock/panels-manager-money").then((module) => ({ default: module.PaymentsPanel })));
const tabs = DEMO_TABS.manager.filter((tab) => HOME_DASHBOARD_TABS.some((step) => step.id === tab.id));

/** The shipped demo panels, in the real workspace shell, with no persistence or live data. */
export default function HomeDashboardPanel({ tab, animate, approved, onApprove }: {
  tab: HomeDashboardTab;
  animate: boolean;
  approved: boolean;
  onApprove(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const fit = () => { if (element.clientWidth > 0) setScale(element.clientWidth / 1120); };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const story = homeDashboardStory(tab);
  const content = tab === "communication" ? <Inbox animate={animate} approved={approved} onApprove={onApprove} />
    : tab === "applications" ? <Applications story={story} />
      : tab === "leases" ? <Leases story={story} />
        : tab === "services" ? <Services story={story} />
          : tab === "bookings" ? <Bookings />
            : <Payments story={story} />;
  // A guided product preview: keyboard/touch navigation belongs to the stage's
  // accessible rail. Hidden controls below this fixed frame never steal focus.
  return (
    <div ref={ref} className="home-dashboard-live rlp-page" data-home-live-panel={tab} style={{ "--home-dashboard-scale": scale } as CSSProperties}>
      <div className="home-dashboard-window" inert>
        <ResidentLifecycleWorkspace portal="manager" tabs={tabs} active={tab} panel onSelect={() => {}}>
          <BarePanelChrome>
            <InertDemoLinks>
              <Suspense fallback={<div className="home-dashboard-panel-loading" role="status">Loading {tabs.find((item) => item.id === tab)?.label} preview…</div>}>
                {content}
              </Suspense>
            </InertDemoLinks>
          </BarePanelChrome>
        </ResidentLifecycleWorkspace>
      </div>
      <span className="home-dashboard-sample">Sample workspace</span>
    </div>
  );
}
