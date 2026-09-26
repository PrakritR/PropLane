"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
import { CANONICAL_DEMO_MANAGER_NAME, CANONICAL_DEMO_RESIDENT_NAME } from "@/lib/demo/demo-canonical-accounts";
import { DEMO_RESIDENT_EMAIL, DEMO_VENDOR_EMAIL, DEMO_VENDOR_NAME, setDemoRole } from "@/lib/demo/demo-session";
import {
  PORTAL_MAIN_CONTENT_CLASS,
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MAIN_CONTENT_INNER_CLASS,
  PORTAL_SHELL_ROOT_CLASS,
} from "@/lib/portal-layout-classes";
import { proPortal } from "@/lib/portals/pro";
import { RESIDENT_PORTAL_BASE_PATH, RESIDENT_UNIFIED_PORTAL_SECTIONS } from "@/lib/portals/resident-sections";
import { vendorPortal } from "@/lib/portals/vendor";
import type { PortalDefinition, PortalSection } from "@/lib/portal-types";
import { cn } from "@/lib/utils";

/** A ref that always holds the latest value, for a callback (the fetch shim)
 * that must read current state without becoming a render dependency. */
function useRefLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

const DEMO_ASSISTANT_ENDPOINT = "/api/agent/demo-chat";

/**
 * The three portals this embed can show — manager, resident, and vendor
 * (captain 2026-09-25: promoted from the earlier two-way manager/resident
 * switch to match `DemoPortalShell`'s three-way toggle). The segmented
 * control below is purely a local `/demo` affordance: real vendor accounts
 * are a separate login, not a role a manager or resident can switch into, so
 * the real avatar-menu "Switch to X portal" interception below stays
 * manager↔resident only, matching what that real component actually offers.
 */
type DemoPortalRole = "manager" | "resident" | "vendor";

/** Same shape `getResidentPortalDefinition()` (src/lib/portals/resident.ts)
 * builds server-side, inlined here because that helper is wrapped in React's
 * `cache()` for server components — this shell is a client component and
 * needs a plain synchronous object. */
const residentPortal: PortalDefinition = {
  kind: "resident",
  basePath: RESIDENT_PORTAL_BASE_PATH,
  title: "Resident Portal",
  accent: "blue",
  sections: RESIDENT_UNIFIED_PORTAL_SECTIONS,
};

/**
 * The demo resident this embed's Resident view signs in as. Deliberately the
 * existing canonical `resident@test.proplane.local` identity
 * (`CANONICAL_DEMO_RESIDENT_NAME`/`DEMO_RESIDENT_EMAIL`) rather than an
 * invented name: it is the one resident in the seeded "Seattle Homes"
 * portfolio with a REAL linked userId (Alder House, see
 * `demo-guided-data.ts`'s `RESIDENTS[0]`), so its lease, rent profile, and
 * charge history are genuinely consistent with what `ResidentLeasePanel` /
 * `ResidentPaymentsPanel` render — not a second, disconnected identity.
 */
const DEMO_RESIDENT_DISPLAY_LABEL = `${CANONICAL_DEMO_RESIDENT_NAME} · Alder House`;

/** App routes a reused portal panel might try to navigate to — never let them
 * reach the real (auth-gated) router; translate them into an in-demo section
 * switch instead, the same interception `DemoPortalShell` already used. */
const DEMO_INTERCEPT_HREF = /^\/(portal|resident|vendor|admin|auth|rent)(\/|$)/;

function parseDemoTarget(href: string): { role: DemoPortalRole; section: string; tab: string | null } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [prefix, section, tab] = parts;
  if (prefix === "portal") return { role: "manager", section: section!, tab: tab ?? null };
  if (prefix === "resident") return { role: "resident", section: section!, tab: tab ?? null };
  if (prefix === "vendor") return { role: "vendor", section: section!, tab: tab ?? null };
  return null;
}

/** Resolves a role to the `PortalDefinition` its shell renders. */
function portalDefinitionFor(role: DemoPortalRole): PortalDefinition {
  if (role === "resident") return residentPortal;
  if (role === "vendor") return vendorPortal;
  return proPortal;
}

/** Sections `DemoSectionRenderer` can render for a role that are NOT one of
 * that role's sidebar nav items — e.g. manager "import" (the real
 * `/portal/properties/import`, reached from a button on Properties, never
 * its own nav entry) — but are still valid `?section=` deep-links. */
const EXTRA_DEEP_LINK_SECTIONS: Partial<Record<DemoPortalRole, string[]>> = {
  manager: ["import"],
};

function isValidDemoSection(role: DemoPortalRole, section: string): boolean {
  if (portalDefinitionFor(role).sections.some((s) => s.section === section)) return true;
  return (EXTRA_DEEP_LINK_SECTIONS[role] ?? []).includes(section);
}

/**
 * The real avatar-menu "Switch to Resident/Property portal" entry
 * (`PortalRoleSwitcher`) needs a live, authenticated `GET
 * /api/auth/portal-roles` response before it renders any button at all, and
 * its click handler then POSTs `/api/auth/set-active-portal` and does a real
 * `router.push` — none of which can work unauthenticated inside `/demo`. To
 * make that real component render and behave correctly here without forking
 * it, this scopes a `fetch` override to the lifetime of this shell (removed
 * on unmount) that answers ONLY that one read-only GET with the single
 * reachable role the embed actually supports, so `PortalRoleSwitcher`
 * renders its real button with its real copy; the click itself is then
 * caught in the capture phase below (by that exact copy) and turned into a
 * local role switch before its real POST/navigate can run — every other
 * fetch passes through untouched.
 */
function installPortalRoleFetchShim(getRole: () => DemoPortalRole): () => void {
  if (typeof window === "undefined") return () => {};
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/auth/portal-roles")) {
      // Vendor accounts have no cross-portal switch in the real product — no
      // reachable role, so the real avatar menu renders no switcher entry.
      const current = getRole();
      const reachable = current === "manager" ? ["resident"] : current === "resident" ? ["manager"] : [];
      return Promise.resolve(new Response(JSON.stringify({ reachableRoles: reachable }), { status: 200 }));
    }
    return original(input, init);
  }) as typeof window.fetch;
  return () => {
    window.fetch = original;
  };
}

/** The OTHER role's switcher copy, from portal-switch-targets.ts's
 * `PORTAL_SWITCH_LABELS` — the label shown while `role` is active. Vendor has
 * no entry: the real avatar menu never offers a vendor account a switch
 * target (see `installPortalRoleFetchShim` above), so this is never indexed
 * with `"vendor"` in practice, but stays `Partial` rather than widening the
 * fallback comparison below to accept `undefined`. */
const ROLE_SWITCH_LABEL: Partial<Record<DemoPortalRole, string>> = {
  manager: "Switch to Resident portal",
  resident: "Switch to Property portal",
};

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

/** Small "Manager | Resident | Vendor" segmented control, above the shell
 * itself — not `DemoPortalShell`'s old pill bar. Purely local state;
 * switching role resets to that portal's Dashboard. */
function DemoRoleSwitchControl({ role, onChange }: { role: DemoPortalRole; onChange: (next: DemoPortalRole) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Switch portal view"
      data-attr="demo-role-switch"
      className="flex shrink-0 items-center gap-0.5 self-start rounded-full border border-border/70 bg-[var(--pl-surface-muted)] p-0.5 m-2"
    >
      {(["manager", "resident", "vendor"] as const).map((r) => (
        <button
          key={r}
          type="button"
          role="tab"
          aria-selected={role === r}
          data-attr={`demo-role-switch-${r}`}
          onClick={() => onChange(r)}
          className={cn(
            "min-h-7 rounded-full px-3 text-[12px] font-bold capitalize transition-colors",
            role === r ? "bg-primary text-white" : "text-muted hover:text-foreground",
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

/**
 * The real signed-in-shaped portal, unauthenticated — the home page's
 * Codex-style hero window embeds this at `/demo`. Manager, Resident, and
 * Vendor views, switched by the segmented control above the shell (all
 * three) or by the real avatar-menu "Switch to X portal" entry (manager and
 * resident only, matching what that real component actually offers) — both
 * local state, never a real navigation: no "Run demo" walkthrough, no
 * floating chat bubble — the captain's reference is the real `/portal`,
 * `/resident`, and `/vendor`, not a redrawn or narrated tour of them
 * (captain 2026-09-25).
 * Composed from the REAL shell components — `PortalSidebar`, `PortalTopBar`,
 * `WorkspaceProvider`, `AssistantDockPanel`, and the shared
 * `DemoSectionRenderer`'s resident branch for Resident — with the demo data
 * layer underneath, not `DemoPortalShell`'s own chrome.
 *
 * `initialRole`/`initialSection` (from `/demo`'s server-read `?role=&section=`,
 * see `page.tsx`) let another page deep-link straight into one slice — e.g.
 * the home page's "Three sign-ins" tabs each embed `/demo?role=vendor&section=work-orders`
 * in a small non-interactive iframe rather than hand-drawing that portal's
 * rows. An invalid or missing section for the given role falls back to
 * Dashboard rather than rendering nothing.
 */
export function DemoManagerShell({
  initialRole = "manager",
  initialSection = "dashboard",
}: {
  initialRole?: DemoPortalRole;
  initialSection?: string;
} = {}) {
  useLayoutEffect(() => {
    setDemoRole(initialRole);
    hydrateDemoGuidedState();
    void seedDemoPortalIdleData();
    // Deliberately NOT in the deps array: this is a one-time mount sync of
    // the module-level demo role/session to the deep-linked initial prop,
    // not a live subscription — `switchRole`/`navigateInDemo` own every
    // later change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [portalRole, setPortalRole] = useState<DemoPortalRole>(initialRole);
  const [section, setSection] = useState(() =>
    isValidDemoSection(initialRole, initialSection) ? initialSection : "dashboard",
  );
  const [tab, setTab] = useState<string | null>(null);
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);

  const definition = portalDefinitionFor(portalRole);
  const meta: PortalSection | undefined = useMemo(
    () => definition.sections.find((s) => s.section === section),
    [definition, section],
  );

  const selectSection = useCallback((next: string, nextTab: string | null = null) => {
    setSection(next);
    setTab(nextTab);
  }, []);

  const switchRole = useCallback((next: DemoPortalRole) => {
    setPortalRole(next);
    setDemoRole(next);
    setSection("dashboard");
    setTab(null);
    setAssistantOpen(false);
  }, []);

  // The fetch shim only needs the LATEST role at click time, not a
  // dependency that reinstalls it on every toggle.
  const portalRoleRef = useRefLatest(portalRole);
  useLayoutEffect(() => installPortalRoleFetchShim(() => portalRoleRef.current), [portalRoleRef]);

  const navigateInDemo = useCallback(
    (href: string) => {
      const target = parseDemoTarget(href);
      if (!target) return;
      const targetDefinition = portalDefinitionFor(target.role);
      if (!targetDefinition.sections.some((s) => s.section === target.section)) return;
      if (target.role !== portalRole) {
        setPortalRole(target.role);
        setDemoRole(target.role);
        setAssistantOpen(false);
      }
      selectSection(target.section, target.tab);
    },
    [portalRole, selectSection],
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

      // The real avatar-menu "Switch to Resident/Property portal" entry
      // (`PortalRoleSwitcher`) — its fetch is shimmed above so it renders
      // for real, its click is caught here (by its real, exact copy) before
      // its own onClick can POST/navigate, and turned into the same local
      // switch the segmented control performs.
      // `PortalRoleSwitcher`'s button text is `"⇄ " + label` (an aria-hidden
      // arrow span before the label text node) — match by substring, not
      // exact equality, since `textContent` includes that leading glyph.
      const button = target?.closest?.("button");
      const switchLabel = ROLE_SWITCH_LABEL[portalRole];
      if (switchLabel && button?.textContent?.includes(switchLabel)) {
        e.preventDefault();
        e.stopPropagation();
        switchRole(portalRole === "manager" ? "resident" : "manager");
        return;
      }

      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!DEMO_INTERCEPT_HREF.test(href)) return;
      e.preventDefault();
      navigateInDemo(href);
    },
    [navigateInDemo, portalRole, switchRole],
  );

  const displayName =
    portalRole === "resident" ? DEMO_RESIDENT_DISPLAY_LABEL : portalRole === "vendor" ? DEMO_VENDOR_NAME : CANONICAL_DEMO_MANAGER_NAME;
  const displayEmail = portalRole === "resident" ? DEMO_RESIDENT_EMAIL : portalRole === "vendor" ? DEMO_VENDOR_EMAIL : "manager@test.proplane.local";

  return (
    <PortalAssistantConfigProvider endpoint={DEMO_ASSISTANT_ENDPOINT} managerName={CANONICAL_DEMO_MANAGER_NAME}>
      <AssistantConversationProvider endpoint={DEMO_ASSISTANT_ENDPOINT} archiveKey={`demo-${portalRole}:seattle-homes`}>
        <PortalContainerProvider container={frameEl}>
          <div
            ref={setFrameEl}
            onClickCapture={onFrameClickCapture}
            className={PORTAL_SHELL_ROOT_CLASS}
          >
            <DemoRoleSwitchControl role={portalRole} onChange={switchRole} />
            <WorkspaceProvider>
              <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
                <PortalSidebar definition={definition} subscriptionTier="paid" initialCollapsed={false} />
                <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  <PortalTopBar kind={definition.kind} basePath={definition.basePath} name={displayName} email={displayEmail} />
                  <main id={PORTAL_MAIN_CONTENT_ID} tabIndex={-1} className={PORTAL_MAIN_CONTENT_CLASS}>
                    <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>
                      <PortalMobileNavBar definition={definition} name={displayName} email={displayEmail} />
                      <DemoSectionRenderer role={portalRole} section={section} tab={tab} meta={meta} />
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
