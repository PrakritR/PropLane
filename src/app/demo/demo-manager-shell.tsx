"use client";

import { useCallback, useLayoutEffect, useMemo, useState, type MouseEvent } from "react";
import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { ASSISTANT_DOCK_INPUT_ID } from "@/components/portal/assistant-dock-input-id";
import { DemoSectionRenderer } from "@/components/demo/demo-section-renderer";
import { PortalMobileNavBar } from "@/components/portal/portal-mobile-nav-bar";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { WorkspaceProvider } from "@/components/portal/workspace-provider";
import { PortalContainerProvider } from "@/components/ui/portal-container-context";
import { AssistantConversationProvider } from "@/lib/axis-assistant/assistant-conversation-context";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { hydrateDemoGuidedState } from "@/lib/demo/demo-guided";
import { seedDemoPortalIdleData } from "@/lib/demo/demo-seed";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import {
  PORTAL_MAIN_CONTENT_CLASS,
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MAIN_CONTENT_INNER_CLASS,
  PORTAL_SHELL_ROOT_CLASS,
} from "@/lib/portal-layout-classes";
import { proPortal } from "@/lib/portals/pro";
import type { PortalSection } from "@/lib/portal-types";

const DEMO_ASSISTANT_ENDPOINT = "/api/agent/demo-chat";

/** App routes a reused portal panel might try to navigate to — never let them
 * reach the real (auth-gated) router; translate them into an in-demo section
 * switch instead, the same interception `DemoPortalShell` already used. */
const DEMO_INTERCEPT_HREF = /^\/(portal|resident|vendor|admin|auth|rent)(\/|$)/;

function parseDemoTarget(href: string): { section: string; tab: string | null } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [prefix, section, tab] = parts;
  if (prefix !== "portal") return null;
  return { section: section!, tab: tab ?? null };
}

/** The real "Ask PropLane" pill's own `data-attr`, from portal-top-bar.tsx. */
const ASK_PROPLANE_PILL_SELECTOR = '[data-attr="portal-ask-proplane"]';

/**
 * The docked assistant — the real `AssistantDockPanel`, not a hand-rolled
 * stand-in — shown only once opened. `PortalAssistantDockRail` can't be
 * reused as-is: its `dockable`/`mode` gate reads `useAxisAssistantDock()`,
 * which is hardcoded off for any `/demo` path (`axis-assistant.tsx`: "never
 * inside /demo, which must not reach /api/agent/chat") — by design, since the
 * REAL dock talks to the real, auth-gated assistant. This rail skips that
 * gate, but keeps the closed-by-default behavior the real one has (its
 * `dockable`/`mode` check is `false` on first load too) — `open` here is
 * plain React state the pill toggles (see `onFrameClickCapture` below),
 * rather than the real dock-store/open-store globals, since those are wired
 * to the same `dockable=false` gate this rail is deliberately bypassing.
 */
function DemoAssistantDockRail({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <aside
      className="relative hidden h-full min-h-0 w-[var(--portal-assistant-rail-width)] shrink-0 self-stretch flex-col overflow-hidden border-l border-border/70 bg-background p-3 lg:flex"
      aria-label="PropLane Assistant"
      data-attr="portal-assistant-dock-rail"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-attr="dashboard-assistant-dock">
        <AssistantDockPanel
          managerName={CANONICAL_DEMO_MANAGER_NAME}
          onClose={onClose}
          inputId={ASSISTANT_DOCK_INPUT_ID}
          className="h-full"
        />
      </div>
    </aside>
  );
}

/**
 * The real signed-in-shaped manager portal, unauthenticated — the home page's
 * Codex-style hero window embeds this at `/demo`. Manager role only, no role
 * switcher, no "Run demo" walkthrough, no floating chat bubble: the captain's
 * reference is the real `/portal`, not a redrawn or narrated tour of it
 * (captain 2026-09-25). Composed from the REAL shell components —
 * `PortalSidebar`, `PortalTopBar`, `WorkspaceProvider`, `AssistantDockPanel` —
 * with the demo data layer underneath, not `DemoPortalShell`'s own chrome.
 */
export function DemoManagerShell() {
  useLayoutEffect(() => {
    hydrateDemoGuidedState();
    void seedDemoPortalIdleData();
  }, []);

  const [section, setSection] = useState("dashboard");
  const [tab, setTab] = useState<string | null>(null);
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const meta: PortalSection | undefined = useMemo(
    () => proPortal.sections.find((s) => s.section === section),
    [section],
  );

  const selectSection = useCallback((next: string, nextTab: string | null = null) => {
    setSection(next);
    setTab(nextTab);
  }, []);

  const navigateInDemo = useCallback(
    (href: string) => {
      const target = parseDemoTarget(href);
      if (target && proPortal.sections.some((s) => s.section === target.section)) {
        selectSection(target.section, target.tab);
      }
    },
    [selectSection],
  );

  const onFrameClickCapture = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const target = e.target as HTMLElement | null;

      // The real "Ask PropLane" pill: intercepted in the capture phase (before
      // PortalTopBar's own onClick, which — since this page never provides an
      // AxisAssistantDockContext — resolves `dockable: false` and would try to
      // open the (unmounted here) real popup instead. Toggling our own state
      // and stopping propagation keeps the pill genuinely functional: closed
      // by default, opened only on click, exactly like the real dock.
      const pill = target?.closest?.(ASK_PROPLANE_PILL_SELECTOR);
      if (pill) {
        e.preventDefault();
        e.stopPropagation();
        setAssistantOpen((open) => !open);
        return;
      }

      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!DEMO_INTERCEPT_HREF.test(href)) return;
      e.preventDefault();
      navigateInDemo(href);
    },
    [navigateInDemo],
  );

  return (
    <PortalAssistantConfigProvider endpoint={DEMO_ASSISTANT_ENDPOINT} managerName={CANONICAL_DEMO_MANAGER_NAME}>
      <AssistantConversationProvider endpoint={DEMO_ASSISTANT_ENDPOINT} archiveKey="demo-manager:seattle-homes">
        <PortalContainerProvider container={frameEl}>
          <div
            ref={setFrameEl}
            onClickCapture={onFrameClickCapture}
            className={PORTAL_SHELL_ROOT_CLASS}
          >
            <WorkspaceProvider>
              <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
                <PortalSidebar definition={proPortal} subscriptionTier="paid" initialCollapsed={false} />
                <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  <PortalTopBar
                    kind="pro"
                    basePath="/portal"
                    name={CANONICAL_DEMO_MANAGER_NAME}
                    email="manager@test.proplane.local"
                  />
                  <main id={PORTAL_MAIN_CONTENT_ID} tabIndex={-1} className={PORTAL_MAIN_CONTENT_CLASS}>
                    <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>
                      <PortalMobileNavBar
                        definition={proPortal}
                        name={CANONICAL_DEMO_MANAGER_NAME}
                        email="manager@test.proplane.local"
                      />
                      <DemoSectionRenderer role="manager" section={section} tab={tab} meta={meta} />
                    </div>
                  </main>
                </div>
                <DemoAssistantDockRail open={assistantOpen} onClose={() => setAssistantOpen(false)} />
              </div>
            </WorkspaceProvider>
          </div>
        </PortalContainerProvider>
      </AssistantConversationProvider>
    </PortalAssistantConfigProvider>
  );
}
