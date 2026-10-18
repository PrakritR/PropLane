"use client";

import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { useHomeStageVisibility } from "./home-scroll-stage";
import type { HomeDashboardTab } from "./home-dashboard-data";

const Panel = lazy(() => import("./home-dashboard-panel"));

class PanelBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function HomeDashboardDeferred({ tab, fallback }: { tab: HomeDashboardTab; fallback: ReactNode }) {
  const { active, near, enhanced } = useHomeStageVisibility();
  const [approved, setApproved] = useState(false);
  return (
    <div className="home-dashboard-frame" data-home-dashboard-tab={tab}>
      {near && active && enhanced ? (
        <PanelBoundary fallback={fallback}>
          <Suspense fallback={fallback}>
            <Panel tab={tab} animate={enhanced} approved={approved} onApprove={() => setApproved(true)} />
            <div className="sr-only">{fallback}</div>
          </Suspense>
        </PanelBoundary>
      ) : fallback}
    </div>
  );
}
