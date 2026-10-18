"use client";

import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { ResidentLifecycleWorkspace } from "./resident-lifecycle-workspace";
import { DEMO_TABS } from "./site/product-mock/demo-nav";
import { BarePanelChrome, InertDemoLinks } from "./site/product-mock/shared";
import { residentStory, vendorStory } from "./site/product-mock/world";
import type { HomeDashboardPortal } from "./home-dashboard-data";
import "./resident-lifecycle-prototypes.css";

const Manager = lazy(() => import("./site/product-mock/dashboards").then((module) => ({ default: module.ManagerDashboardView })));
const Resident = lazy(() => import("./site/product-mock/panels-resident").then((module) => ({ default: module.ResidentHomePanel })));
const Vendor = lazy(() => import("./site/product-mock/panels-vendor").then((module) => ({ default: module.VendorServicesPanel })));
const Owner = lazy(() => import("./home-dashboard-owner"));

/** Real portal screens through the existing fixture adapters; no session or live data source. */
export default function HomeDashboardPanel({ portal }: { portal: HomeDashboardPortal }) {
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
  const content = portal === "manager" ? <Manager story={residentStory("pay")} scrollWithinWindow={false} />
    : portal === "resident" ? <Resident story={residentStory("pay")} />
      : portal === "vendor" ? <Vendor story={vendorStory("visit")} /> : <Owner />;
  const active = portal === "manager" ? "dashboard" : portal === "resident" ? "move-in" : "work-orders";
  const screen = <Suspense fallback={<div className="home-dashboard-panel-loading" role="status">Loading {portal} preview…</div>}>{content}</Suspense>;
  return <div ref={ref} className="home-dashboard-live rlp-page" data-home-live-panel={portal} style={{ "--home-dashboard-scale": scale } as CSSProperties}>
    <div className="home-dashboard-window" inert>
      {portal === "owner" ? screen : <ResidentLifecycleWorkspace portal={portal} tabs={DEMO_TABS[portal]} active={active} panel onSelect={() => {}}><div className="rlp-panel-frame"><BarePanelChrome><InertDemoLinks>{screen}</InertDemoLinks></BarePanelChrome></div></ResidentLifecycleWorkspace>}
    </div>
  </div>;
}
