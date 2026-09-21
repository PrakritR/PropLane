"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import { PortalNavCountBadge } from "@/components/portal/portal-nav-count-badge";
import { usePortalNavCounts } from "@/hooks/use-portal-nav-counts";
import { PortalContainerProvider } from "@/components/ui/portal-container-context";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { groupNavItems, isHiddenFromMobileNav } from "@/lib/portals/nav-groups";
import { orderNativeBottomNavItems } from "@/lib/native/portal-bottom-nav";
import { proPortal } from "@/lib/portals/pro";
import { vendorPortal } from "@/lib/portals/vendor";
import { RESIDENT_APPROVED_PORTAL_SECTIONS, RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import type { PortalDefinition, PortalSection } from "@/lib/portal-types";
import { closeAxisAssistant } from "@/lib/axis-assistant/open-store";
import { DEMO_OPEN_RESIDENT_APPLY_EVENT } from "@/lib/demo/demo-playback";
import {
  DEMO_NAVIGATE_EVENT,
  getDemoRole,
  setDemoRole,
  subscribeDemoRole,
  type DemoPortalRole,
} from "@/lib/demo/demo-session";
import { DEMO_PORTAL_SCROLL_ID } from "@/lib/portal-layout-classes";
import {
  exitGuidedDemoTour,
  getDemoGuidedServerSnapshot,
  getDemoGuidedState,
  getGuidedStepDef,
  hydrateDemoGuidedState,
  startGuidedDemoTour,
  subscribeDemoGuidedState,
} from "@/lib/demo/demo-guided";
import type { DemoSegment } from "@/lib/demo/demo-segments";
import { DEMO_SEGMENT_LABELS, DEMO_SEGMENT_OPTIONS } from "@/lib/demo/demo-segments";
import { seedDemoIdleData, seedDemoPortalIdleData } from "@/lib/demo/demo-seed";
import { isDemoSignedIn, purgeDemoSeededSessionStorage } from "@/lib/demo/demo-client-teardown";
import { DemoSectionRenderer } from "@/components/demo/demo-section-renderer";
import { DemoFrameAssistant } from "@/components/demo/demo-frame-assistant";
import { DemoCursorPlayback } from "@/components/demo/demo-cursor-playback";
import { DemoSegmentPlayback } from "@/components/demo/demo-segment-playback";
import { Select } from "@/components/ui/input";

/** App routes a reused portal panel might try to navigate to. In the demo these
 * must never reach the real (auth-gated) router — either they map to an in-demo
 * section switch or they are swallowed so the visitor stays in the sandbox. */
const DEMO_INTERCEPT_HREF = /^\/(portal|resident|vendor|admin|auth|rent)(\/|$)/;

/** Parse an in-app portal href (`/resident/documents/receipts`) into the demo's
 * section + tab. Returns null for routes with no in-demo equivalent
 * (`/auth/...`, `/rent/...`, `/admin/...`). */
function parseDemoTarget(href: string): { section: string; tab: string | null } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [prefix, section, tab] = parts;
  if (prefix !== "portal" && prefix !== "resident" && prefix !== "vendor") return null;
  return { section: section!, tab: tab ?? null };
}

function definitionForRole(role: DemoPortalRole): PortalDefinition {
  if (role === "resident") {
    return {
      kind: "resident",
      basePath: RESIDENT_PORTAL_BASE_PATH,
      title: "Resident Portal",
      accent: "blue",
      sections: RESIDENT_APPROVED_PORTAL_SECTIONS,
    };
  }
  if (role === "vendor") return vendorPortal;
  return proPortal;
}

const ROLES: { id: DemoPortalRole; label: string }[] = [
  { id: "resident", label: "Resident" },
  { id: "manager", label: "Manager" },
  { id: "vendor", label: "Vendor" },
];

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
export function DemoPortalShell() {
  useLayoutEffect(() => {
    hydrateDemoGuidedState();
    void seedDemoPortalIdleData();
  }, []);

  // When a signed-out visitor leaves the embedded demo (SPA nav away, or a full
  // navigation such as signing in — which then resets module memory via
  // location.replace), purge the demo-seeded sessionStorage so the real portal
  // never reads demo residue. Skipped when signed in: those users never seed
  // (see demo-seed.ts) and keep a legitimate portal cache under the same keys.
  useEffect(() => {
    const purge = () => {
      if (!isDemoSignedIn()) purgeDemoSeededSessionStorage();
    };
    window.addEventListener("pagehide", purge);
    return () => {
      window.removeEventListener("pagehide", purge);
      purge();
    };
  }, []);

  const guidedState = useSyncExternalStore(
    subscribeDemoGuidedState,
    getDemoGuidedState,
    getDemoGuidedServerSnapshot,
  );
  const guidedActive = guidedState.mode === "guided" && guidedState.step > 0;
  const guidedStep = guidedActive ? guidedState.step : 0;
  const stepDef = getGuidedStepDef(guidedStep);

  const role = useSyncExternalStore(subscribeDemoRole, getDemoRole, () => "manager" as const);
  const def = useMemo(() => definitionForRole(role), [role]);
  // Same nav count badges as the real portal sidebar, fed by the seeded stores.
  const navCounts = usePortalNavCounts(def.kind);
  const navGroups = useMemo(
    () => groupNavItems(def.kind, def.sections.map((s) => ({ section: s.section, meta: s }))),
    [def],
  );
  const demoMobileStripSections = useMemo(() => {
    const items = def.sections.map((s) => ({ section: s.section, meta: s }));
    return orderNativeBottomNavItems(items, def.kind).filter(
      (item) => !isHiddenFromMobileNav(def.kind, item.section),
    );
  }, [def]);
  // Match the real portal sidebar: the trailing unlabeled group (Settings) is
  // pushed to the bottom, separate from the groups above it.
  const firstTrailingGroupIdx = useMemo(
    () => navGroups.findIndex((g) => g.id === "account" || g.id === "more"),
    [navGroups],
  );

  // The demo frame element — reused portal modals portal into it (see
  // PortalContainerProvider below) so they stay bounded inside the demo screen
  // instead of covering the whole browser.
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  // Collapsible sidebar, mirroring the real PortalSidebar "«/»" toggle.
  const [collapsed, setCollapsed] = useState(false);

  const [section, setSection] = useState<string>("dashboard");
  const [tab, setTab] = useState<string | null>(null);
  const [selectedSegment, setSelectedSegment] = useState<DemoSegment>("overall");
  const meta: PortalSection | undefined = useMemo(
    () => def.sections.find((s) => s.section === section),
    [def, section],
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  const selectSection = useCallback((next: string, nextTab: string | null = null) => {
    setSection(next);
    setTab(nextTab);
    scrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  // Resolve an intercepted in-app href to an in-demo section switch. Unknown
  // sections (or auth/rent routes) are swallowed so the visitor never leaves.
  const navigateInDemo = useCallback(
    (href: string) => {
      const target = parseDemoTarget(href);
      if (target && def.sections.some((s) => s.section === target.section)) {
        selectSection(target.section, target.tab);
        if (role === "resident" && target.section === "applications" && target.tab === "apply") {
          const propertyId =
            new URL(href, "http://demo.local").searchParams.get("propertyId")?.trim() || undefined;
          window.dispatchEvent(
            new CustomEvent(DEMO_OPEN_RESIDENT_APPLY_EVENT, { detail: { propertyId } }),
          );
        }
      }
    },
    [def, role, selectSection],
  );

  // The reused portal panels render real <Link>/<a> elements pointing at
  // /portal, /resident, etc. A capture-phase handler on the demo frame catches
  // those clicks before Next's Link navigates, so nothing escapes the sandbox.
  const onFrameClickCapture = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!DEMO_INTERCEPT_HREF.test(href)) return;
      e.preventDefault();
      navigateInDemo(href);
    },
    [navigateInDemo],
  );

  // Programmatic navigations (router.push via usePortalNavigate / portalNavClick)
  // can't be caught by a click handler, so those code paths dispatch this event
  // in demo mode instead of pushing a route.
  useEffect(() => {
    const handler = (e: Event) => {
      const href = (e as CustomEvent<{ href?: string }>).detail?.href;
      if (typeof href === "string") navigateInDemo(href);
    };
    window.addEventListener(DEMO_NAVIGATE_EVENT, handler);
    return () => window.removeEventListener(DEMO_NAVIGATE_EVENT, handler);
  }, [navigateInDemo]);

  const navigateToProperties = useCallback(() => {
    setDemoRole("manager");
    selectSection("properties", null);
  }, [selectSection]);

  const navigateToResidentDashboard = useCallback(() => {
    setDemoRole("resident");
    selectSection("dashboard", null);
  }, [selectSection]);

  const navigateToResidentApplications = useCallback(() => {
    setDemoRole("resident");
    selectSection("applications", null);
  }, [selectSection]);

  const navigateToManagerApplications = useCallback(() => {
    setDemoRole("manager");
    selectSection("applications", null);
  }, [selectSection]);

  const navigateToManagerLeases = useCallback(
    (nextTab: string | null = null) => {
      setDemoRole("manager");
      selectSection("leases", nextTab);
    },
    [selectSection],
  );

  const navigateToResidentLease = useCallback(() => {
    setDemoRole("resident");
    selectSection("lease", null);
  }, [selectSection]);

  const navigateToManagerPayments = useCallback(() => {
    setDemoRole("manager");
    selectSection("payments", null);
  }, [selectSection]);

  const navigateToResidentPayments = useCallback(() => {
    setDemoRole("resident");
    selectSection("payments", null);
  }, [selectSection]);

  const navigateToManagerServices = useCallback(
    (nextTab: string | null = "work-orders") => {
      setDemoRole("manager");
      selectSection("services", nextTab);
    },
    [selectSection],
  );

  const navigateToResidentServices = useCallback(
    (nextTab: string | null = "requests") => {
      setDemoRole("resident");
      selectSection("services", nextTab);
    },
    [selectSection],
  );

  const navigateToVendorWorkOrders = useCallback(() => {
    setDemoRole("vendor");
    selectSection("work-orders", null);
  }, [selectSection]);

  const navigateToManagerInbox = useCallback(
    (nextTab: string | null = "unopened") => {
      setDemoRole("manager");
      selectSection("communication", nextTab);
    },
    [selectSection],
  );

  const navigateToResidentInbox = useCallback(
    (nextTab: string | null = "unopened") => {
      setDemoRole("resident");
      selectSection("communication", nextTab);
    },
    [selectSection],
  );

  const navigateToManagerPromotion = useCallback(() => {
    setDemoRole("manager");
    selectSection("promotion", null);
  }, [selectSection]);

  const startTour = useCallback(() => {
    closeAxisAssistant();
    startGuidedDemoTour(selectedSegment);
    if (selectedSegment === "overall" || selectedSegment === "leasing" || selectedSegment === "applications") {
      navigateToProperties();
    } else if (selectedSegment === "payments") {
      navigateToManagerPayments();
    } else if (selectedSegment === "communication") {
      navigateToManagerInbox("unopened");
    } else if (selectedSegment === "promotion") {
      navigateToManagerPromotion();
    } else {
      navigateToManagerServices("work-orders");
    }
  }, [
    navigateToManagerInbox,
    navigateToManagerPayments,
    navigateToManagerPromotion,
    navigateToManagerServices,
    navigateToProperties,
    selectedSegment,
  ]);

  // Shared landing state for BOTH tour endings (Exit button + natural
  // autoplay finish): re-seed the idle portfolio (the tour wrote rows under
  // the guided scope, unreadable once the scope flips back) and return to the
  // manager dashboard.
  const finishTourCleanup = useCallback(() => {
    closeAxisAssistant();
    seedDemoIdleData();
    setDemoRole("manager");
    selectSection("dashboard", null);
  }, [selectSection]);

  const exitTour = useCallback(() => {
    // Flip guided state FIRST so the in-flight autoplay chain bails at its
    // next checkpoint instead of racing the idle re-seed below.
    exitGuidedDemoTour();
    finishTourCleanup();
  }, [finishTourCleanup]);

  const switchRole = useCallback(
    (next: DemoPortalRole) => {
      if (guidedActive) return;
      closeAxisAssistant();
      setDemoRole(next);
      setSection("dashboard");
      setTab(null);
    },
    [guidedActive],
  );

  return (
    <PortalContainerProvider container={frameEl}>
    <PortalAssistantConfigProvider endpoint="/api/agent/demo-chat" managerName={null}>
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-3 py-4 sm:px-4">
      {/* Controls bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex items-center gap-1 rounded-full border border-border bg-card p-1 text-sm">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => switchRole(r.id)}
              disabled={guidedActive}
              title={guidedActive ? "Finish or exit the demo to switch roles" : undefined}
              data-attr={`demo-role-${r.id}`}
              className={cn(
                "rounded-full px-3.5 py-1.5 font-medium transition",
                role === r.id ? "bg-primary text-white shadow-sm" : "text-muted hover:text-foreground",
                guidedActive && role !== r.id && "cursor-not-allowed opacity-40",
              )}
              aria-pressed={role === r.id}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {guidedActive && stepDef ? (
            <div className="flex min-w-0 flex-col gap-0.5 sm:mr-2">
              <span className="text-xs font-semibold text-foreground">
                {stepDef.title}
              </span>
              <span className="hidden max-w-md truncate text-xs text-muted sm:inline">{stepDef.hint}</span>
            </div>
          ) : (
            <span className="hidden text-xs text-muted sm:inline">Interactive demo · click anything</span>
          )}
          {!guidedActive ? (
            <>
              <label className="hidden items-center gap-2 sm:flex">
                <span className="sr-only">Demo segment</span>
                <Select
                  value={selectedSegment}
                  onChange={(e) => setSelectedSegment(e.target.value as DemoSegment)}
                  data-attr="demo-segment-select"
                  className="h-9 max-w-[11rem] rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground"
                >
                  {DEMO_SEGMENT_OPTIONS.map((id) => (
                    <option key={id} value={id}>
                      {DEMO_SEGMENT_LABELS[id]}
                    </option>
                  ))}
                </Select>
              </label>
              <button
                type="button"
                onClick={startTour}
                data-attr="demo-run"
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
                style={{ background: "var(--btn-primary)" }}
              >
                <PlayIcon />
                Run demo
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={exitTour}
              data-attr="demo-exit"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-sm font-medium text-muted transition hover:bg-accent/60 hover:text-foreground"
            >
              Exit tour
            </button>
          )}
        </div>
      </div>

      {/* Portal window */}
      <div
        ref={setFrameEl}
        onClickCapture={onFrameClickCapture}
        className="demo-portal-frame relative flex h-[min(85dvh,920px)] min-h-[70vh] overflow-hidden rounded-2xl border border-border bg-background shadow-[var(--shadow-lg,0_20px_60px_-30px_rgba(15,23,42,0.5))]"
      >
        <DemoCursorPlayback container={frameEl} />
        <DemoSegmentPlayback
          frameEl={frameEl}
          active={guidedActive}
          onTourFinished={finishTourCleanup}
          setDemoRole={setDemoRole}
          onNavigateProperties={navigateToProperties}
          onNavigateResidentDashboard={navigateToResidentDashboard}
          onNavigateResidentApplications={navigateToResidentApplications}
          onNavigateManagerApplications={navigateToManagerApplications}
          onNavigateManagerLeases={navigateToManagerLeases}
          onNavigateResidentLease={navigateToResidentLease}
          onNavigateManagerPayments={navigateToManagerPayments}
          onNavigateResidentPayments={navigateToResidentPayments}
          onNavigateManagerServices={navigateToManagerServices}
          onNavigateResidentServices={navigateToResidentServices}
          onNavigateVendorWorkOrders={navigateToVendorWorkOrders}
          onNavigateManagerInbox={navigateToManagerInbox}
          onNavigateResidentInbox={navigateToResidentInbox}
          onNavigateManagerPromotion={navigateToManagerPromotion}
        />
        {/* Sidebar */}
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r border-border bg-background glass-nav transition-[width] duration-200 md:flex",
            collapsed ? "w-[58px]" : "w-[208px]",
          )}
        >
          {collapsed ? (
            <div className="flex h-12 shrink-0 items-center justify-center border-b border-border">
              <button
                type="button"
                onClick={() => setCollapsed(false)}
                aria-label="Expand sidebar"
                aria-expanded={false}
                data-attr="demo-sidebar-expand"
                className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-accent/70 hover:text-foreground"
              >
                <ChevronsRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : (
            <div className="flex h-12 items-center gap-2 border-b border-border px-3">
              <span className="text-sm font-semibold text-foreground">PropLane</span>
              <span className="rounded-full bg-primary/12 px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.1em] text-primary">
                {ROLES.find((r) => r.id === role)?.label ?? "Manager"}
              </span>
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                aria-label="Collapse sidebar"
                aria-expanded
                data-attr="demo-sidebar-collapse"
                className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-accent/70 hover:text-foreground"
              >
                <ChevronsLeft className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}
          <nav
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-2",
              collapsed ? "items-center px-2" : "px-2",
            )}
            aria-label="Demo sections"
          >
            {navGroups.map((group, i) => (
              <div
                key={group.id}
                className={cn(
                  "flex w-full flex-col gap-0.5",
                  collapsed && "items-center",
                  i === firstTrailingGroupIdx ? "mt-auto pt-2" : i > 0 && "mt-1",
                )}
              >
                {group.label && !collapsed ? (
                  <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-[0.09em] text-muted/70">
                    {group.label}
                  </p>
                ) : null}
                {collapsed && i > 0 ? <div className="my-1 h-px w-6 bg-border" aria-hidden /> : null}
                {group.items.map((item) => {
                  const active = section === item.section;
                  const count = navCounts[item.section]?.count ?? 0;
                  const tone = navCounts[item.section]?.tone ?? "muted";
                  return (
                    <button
                      key={item.section}
                      type="button"
                      data-attr={`demo-nav-${item.section}`}
                      onClick={() => selectSection(item.section, item.meta.tabs[0]?.id ?? null)}
                      title={collapsed ? item.meta.label : undefined}
                      className={cn(
                        collapsed
                          ? "relative grid h-9 w-9 place-items-center rounded-[12px] transition"
                          : "relative flex min-h-9 items-center gap-2.5 rounded-[12px] px-2.5 py-[7px] text-left text-[13px] font-medium transition",
                        active
                          ? "bg-[var(--glass-fill)] text-foreground ring-1 ring-border/60 [html[data-theme=light]_&]:bg-card [html[data-theme=light]_&]:shadow-[var(--shadow-sm)]"
                          : "text-muted hover:bg-accent/70 hover:text-foreground",
                      )}
                      aria-current={active ? "page" : undefined}
                    >
                      <span className={active ? "text-primary" : "opacity-80"} aria-hidden>
                        <PortalNavIcon section={item.section} className="h-[17px] w-[17px] shrink-0" />
                      </span>
                      {collapsed ? null : (
                        <>
                          <span className="min-w-0 flex-1 truncate">{item.meta.label}</span>
                          <PortalNavCountBadge count={count} tone={tone} />
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>

        {/* Mobile section strip */}
        <div className="absolute inset-x-0 top-0 z-10 border-b border-border bg-background/95 backdrop-blur md:hidden">
          <nav className="flex gap-1.5 overflow-x-auto px-3 py-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Demo sections">
            {demoMobileStripSections.map((item) => {
              const active = section === item.section;
              return (
                <button
                  key={item.section}
                  type="button"
                  data-mobile-strip-section={item.section}
                  data-attr={`demo-nav-${item.section}`}
                  onClick={() => selectSection(item.section, item.meta.tabs[0]?.id ?? null)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-[14px] px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition",
                    active ? "bg-primary text-white" : "bg-accent/50 text-muted",
                  )}
                >
                  {item.meta.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Content */}
        <div
          id={DEMO_PORTAL_SCROLL_ID}
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-8 pt-14 sm:px-5 md:pt-5"
        >
          {/* No generic sub-tab strip here: every multi-tab panel renders its own
              tab row (TabNav / status pills) in its page-shell header, and those
              tab clicks are intercepted (onFrameClickCapture / DEMO_NAVIGATE_EVENT)
              to switch the demo tab. A strip here would duplicate that row. */}
          <DemoSectionRenderer key={`${role}:${section}:${guidedStep}`} role={role} section={section} tab={tab} meta={meta} />
        </div>

        <DemoFrameAssistant />
      </div>
    </div>
    </PortalAssistantConfigProvider>
    </PortalContainerProvider>
  );
}
