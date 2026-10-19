"use client";

import { Component, lazy, Suspense, type ReactNode } from "react";
import { useHomeDashboardVisibility } from "./home-dashboard-tour";
import type { HomeDashboardPortal } from "./home-dashboard-data";

const Panel = lazy(() => import("./home-dashboard-panel"));
class PanelBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function HomeDashboardDeferred({ portal, fallback }: { portal: HomeDashboardPortal; fallback: ReactNode }) {
  const { active, near } = useHomeDashboardVisibility();
  return <div className="home-dashboard-frame" data-home-dashboard-portal={portal}>
    {near && active ? <PanelBoundary fallback={fallback}><Suspense fallback={fallback}><Panel portal={portal} /></Suspense></PanelBoundary> : fallback}
  </div>;
}
