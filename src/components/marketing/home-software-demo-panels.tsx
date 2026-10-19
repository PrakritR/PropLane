"use client";

import HomeDashboardPanel from "./home-dashboard-panel";
import type { HomeDashboardPortal } from "./home-dashboard-data";
import type { SoftwareDemoScene } from "./home-software-demo-scenes";

const noop = () => undefined;

/** The walkthrough and exploration share one mounted, fixture-backed portal. */
export default function HomeSoftwareDemoPanels({ scene, request, draft, onApprove, onReady, portal = "manager", interactive = false, onInteract = noop }: {
  scene: SoftwareDemoScene;
  request: string;
  draft: string;
  onApprove(): void;
  onReady(scene: SoftwareDemoScene): void;
  portal?: HomeDashboardPortal;
  interactive?: boolean;
  onInteract?(): void;
}) {
  return <HomeDashboardPanel portal={portal} walkthrough={interactive ? undefined : { scene, request, draft, onApprove, onReady, onInteract }} />;
}
