"use client";

import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { ResidentLifecycleWorkspace } from "./resident-lifecycle-workspace";
import { DEMO_TABS } from "./site/product-mock/demo-nav";
import { residentStory, vendorStory } from "./site/product-mock/world";
import type { HomeDashboardPortal } from "./home-dashboard-data";
import { PortalSectionTabsView } from "@/components/portal/portal-section-tabs-view";
import { navSectionTabsFor } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";
import { vendorPortal } from "@/lib/portals/vendor";
import { RESIDENT_UNIFIED_PORTAL_SECTIONS } from "@/lib/portals/resident-sections";
import { ManagerCommunication, type SampleMessage } from "./resident-lifecycle-manager";
import type { SoftwareDemoScene } from "./home-software-demo-scenes";
import "./resident-lifecycle-prototypes.css";

const definitions = { manager: proPortal.sections, resident: RESIDENT_UNIFIED_PORTAL_SECTIONS, vendor: vendorPortal.sections };

const Panel = lazy(() => import("./site/product-mock/demo-panels").then((module) => ({ default: module.DemoPanel })));
const Owner = lazy(() => import("./home-dashboard-owner"));

export type HomeDashboardWalkthrough = {
  scene: SoftwareDemoScene;
  request: string;
  draft: string;
  onApprove(): void;
  onReady(scene: SoftwareDemoScene): void;
  onInteract(): void;
};

function walkthroughTab(scene: SoftwareDemoScene) {
  return scene === "tour" ? "calendar" : scene === "paid" ? "payments" : "communication";
}

/** Commit after the lazy page resolves, rather than timing the loading placeholder. */
function WalkthroughReady({ scene, onReady }: Pick<HomeDashboardWalkthrough, "scene" | "onReady">) {
  useEffect(() => { onReady(scene); }, [scene, onReady]);
  return null;
}

/** Real portal screens through the existing fixture adapters; no session or live data source. */
export default function HomeDashboardPanel({ portal, walkthrough }: { portal: HomeDashboardPortal; walkthrough?: HomeDashboardWalkthrough }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const guided = portal === "manager" ? walkthrough : undefined;
  const scene = guided?.scene;
  const request = guided?.request;
  const previousScene = useRef(scene);
  const [communicationEpoch, setCommunicationEpoch] = useState(0);
  const [page, setPage] = useState(() => ({ tab: guided ? walkthroughTab(guided.scene) : portal === "manager" ? "dashboard" : portal === "resident" ? "move-in" : "work-orders", sub: undefined as string | undefined }));
  const [conversation, setConversation] = useState<{ request: string | undefined; replies: SampleMessage[] }>(() => ({ request, replies: [] }));
  useEffect(() => {
    if (scene) setPage({ tab: walkthroughTab(scene), sub: undefined });
  }, [scene]);
  useEffect(() => {
    const previous = previousScene.current;
    previousScene.current = scene;
    // A new guided start restores its prospect, folder and search. Normal text →
    // inbox progression and pausing preserve this panel; the outer shell never resets.
    if ((scene === "text" && previous !== "text") || (scene === "inbox" && previous === undefined)) {
      setCommunicationEpoch((epoch) => epoch + 1);
    }
  }, [scene]);
  useEffect(() => {
    if (request !== undefined) setConversation((current) => {
      // Replaying starts a new sample conversation; pausing keeps the existing one.
      if (current.request !== request || (scene === "text" && current.replies.length > 0)) return { request, replies: [] };
      return current;
    });
  }, [request, scene]);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const fit = () => { if (element.clientWidth > 0) setScale(element.clientWidth / 1120); };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const navigate = (tab: string, sub?: string) => {
    guided?.onInteract();
    setPage({ tab, sub });
  };
  const active = scene ? walkthroughTab(scene) : page.tab;
  const group = portal === "owner" ? null : navSectionTabsFor(portal, active, DEMO_TABS[portal].flatMap((row) => row.members));
  const sectionTabs = group && portal !== "owner" ? <div className="mx-4 mt-4 shrink-0 lg:mx-8">
    <PortalSectionTabsView
      section={active}
      label={group.label}
      items={group.sections.map((id) => ({
        id,
        label: group.tabLabels[id] ?? definitions[portal].find((section) => section.section === id)?.label ?? id,
        href: `#demo/${id}`,
        dataAttr: `section-tab-${id}`,
      }))}
      onChange={navigate}
    />
  </div> : null;
  const story = portal === "vendor" ? vendorStory("visit") : residentStory(scene && scene !== "paid" ? "tour" : "pay");
  const incoming = request ?? conversation.request;
  const content = portal === "owner" ? <Owner /> : portal === "manager" && active === "communication" && incoming !== undefined ? <ManagerCommunication
    key={communicationEpoch}
    messages={[{ from: "resident", text: incoming }, ...conversation.replies]}
    draft={scene === "draft" || scene === "approve" ? guided?.draft : null}
    onApprove={() => {
      if (!guided) return;
      setConversation((current) => ({ ...current, replies: [...current.replies, { from: "manager", text: guided.draft }] }));
      guided.onApprove();
    }}
    onReply={(text) => {
      if (!text.trim()) return false;
      setConversation((current) => ({ ...current, replies: [...current.replies, { from: "manager", text: text.trim() }] }));
      return true;
    }}
  /> : <Panel portal={portal} tab={active} sub={page.sub} onNavigate={navigate} story={story} stage={portal === "vendor" ? "visit" : scene && scene !== "paid" ? "tour" : "pay"} />;
  const screen = <Suspense fallback={<div className="home-dashboard-panel-loading" role="status">Loading {portal} preview…</div>}>{content}{guided ? <WalkthroughReady scene={guided.scene} onReady={guided.onReady} /> : null}</Suspense>;
  return <div ref={ref} className="home-dashboard-live rlp-page" data-home-live-panel={portal} style={{ "--home-dashboard-scale": scale } as CSSProperties}>
    <div className="home-dashboard-window">
      {portal === "owner" ? screen : <ResidentLifecycleWorkspace story={story} portal={portal} tabs={DEMO_TABS[portal]} active={active} panel onSelect={navigate}><div className="rlp-panel-frame" style={{ flexDirection: "column" }}>{sectionTabs}<div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto" data-software-demo-panel={scene}>{screen}</div></div></ResidentLifecycleWorkspace>}
    </div>
  </div>;
}
