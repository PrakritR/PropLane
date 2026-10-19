"use client";

import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { ResidentLifecycleWorkspace } from "./resident-lifecycle-workspace";
import { DEMO_TABS } from "./site/product-mock/demo-nav";
import { residentStory, vendorStory } from "./site/product-mock/world";
import type { HomeDashboardPortal } from "./home-dashboard-data";
import "./resident-lifecycle-prototypes.css";

const Panel = lazy(() => import("./site/product-mock/demo-panels").then((module) => ({ default: module.DemoPanel })));
const Owner = lazy(() => import("./home-dashboard-owner"));

/** Real portal screens through the existing fixture adapters; no session or live data source. */
export default function HomeDashboardPanel({ portal }: { portal: HomeDashboardPortal }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(() => ({ tab: portal === "manager" ? "dashboard" : portal === "resident" ? "move-in" : "work-orders", sub: undefined as string | undefined }));
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const fit = () => { if (element.clientWidth > 0) setScale(element.clientWidth / 1120); };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const content = portal === "owner" ? <Owner /> : <Panel portal={portal} tab={page.tab} sub={page.sub} onNavigate={(tab) => setPage({ tab, sub: undefined })} story={portal === "vendor" ? vendorStory("visit") : residentStory("pay")} stage={portal === "vendor" ? "visit" : "pay"} />;
  const screen = <Suspense fallback={<div className="home-dashboard-panel-loading" role="status">Loading {portal} preview…</div>}>{content}</Suspense>;
  return <div ref={ref} className="home-dashboard-live rlp-page" data-home-live-panel={portal} style={{ "--home-dashboard-scale": scale } as CSSProperties}>
    <div className="home-dashboard-window">
      {portal === "owner" ? screen : <ResidentLifecycleWorkspace portal={portal} tabs={DEMO_TABS[portal]} active={page.tab} panel onSelect={(tab, sub) => setPage({ tab, sub })}><div className="rlp-panel-frame">{screen}</div></ResidentLifecycleWorkspace>}
    </div>
  </div>;
}
