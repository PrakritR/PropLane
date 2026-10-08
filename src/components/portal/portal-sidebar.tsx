"use client";

import { AxisLogoMark } from "@/components/brand/axis-logo";
import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import { PortalNavCountBadge } from "@/components/portal/portal-nav-count-badge";
import {
  PortalNativeMoreNavButton,
  PortalNativeMoreSheet,
  type PortalMoreNavItem,
} from "@/components/portal/portal-native-more-sheet";
import { useCoManagerNavSections } from "@/hooks/use-co-manager-nav-sections";
import { useIsSmallPortalViewport, useNativeChrome } from "@/hooks/use-is-native-app";
import { usePortalNavCounts } from "@/hooks/use-portal-nav-counts";
import { usePortalSession } from "@/hooks/use-portal-session";
import { portalNavLockNavigable, portalNavSectionLocked } from "@/lib/portals/nav-locks";
import {
  residentNavLockReason,
  residentNavSectionVisibleInNav,
  type ResidentPortalNavStage,
} from "@/lib/resident-portal-nav";
import { shouldOpenNativeSectionsSheet } from "@/lib/native/open-portal-sections-sheet";
import {
  nativeBottomBarEnabledForKind,
  nativeBottomNavShowMoreTab,
  orderNativeBottomNavItems,
  splitNativeBottomNavItems,
} from "@/lib/native/portal-bottom-nav";
import { adjacentPrimarySection, resolveSwipePageDirection } from "@/lib/native/portal-swipe-page";
import { playSwipeEnter, playSwipeExit, resetSwipeTransform } from "@/lib/native/portal-swipe-page-transition";
import { observeNativeBottomNavInset } from "@/lib/native/sync-portal-bottom-nav-inset";
import {
  isCrossPortalNavigation,
  portalNavClick,
  prefetchPortalHref,
  usePortalNavigate,
} from "@/lib/portal-nav-client";
import {
  portalBackgroundPrefetchEnabled,
  portalIntentPrefetchEnabled,
  portalMobileLinkPrefetchEnabled,
} from "@/lib/portal-nav-prefetch";
import {
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MOBILE_CHROME_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ICON_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS,
} from "@/lib/portal-layout-classes";
import {
  getPortalSidebarCollapsed,
  subscribePortalSidebarCollapsed,
  syncPortalSidebarCollapsedAttribute,
} from "@/lib/portal-sidebar-collapse-store";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { WorkspaceSwitcher } from "@/components/portal/workspace-switcher";
import { groupNavItems, isAppNavHiddenInNativeShell, isHiddenFromMobileNav } from "@/lib/portals/nav-groups";
import {
  buildPortalNavItems,
  type PortalSidebarNavItem,
  type PortalSidebarNavSubItem,
} from "@/components/portal/portal-nav-model";
import type { PortalDefinition, PortalKind } from "@/lib/portal-types";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, SquarePen } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useIsClient } from "@/hooks/use-is-client";

function portalBrandCopy(kind: PortalKind): { subtitle: string; ariaLabel: string } {
  switch (kind) {
    case "resident":
      return { subtitle: "Resident", ariaLabel: "PropLane Resident Portal home" };
    case "admin":
      return { subtitle: "Admin", ariaLabel: "PropLane Admin Portal home" };
    case "vendor":
      return { subtitle: "Vendor", ariaLabel: "PropLane Vendor Portal home" };
    default:
      return { subtitle: "Manager", ariaLabel: "PropLane Manager Portal home" };
  }
}

function navLinkClass(active: boolean, locked?: boolean, unread?: boolean) {
  return cn(
    "group relative flex h-8 items-center justify-between gap-2 rounded-[7px] px-2 text-[15px] leading-5 tracking-[-0.003em] transition-colors duration-100",
    active
      ? "bg-[var(--portal-sidebar-active-bg,#e9effe)] font-semibold text-[var(--portal-sidebar-active-fg,#1f55e0)]"
      : locked
        ? "font-normal text-[#3c414b]/50 hover:bg-[rgba(17,24,39,0.045)]"
        : unread
          ? "font-[650] text-foreground hover:bg-[rgba(17,24,39,0.045)]"
          : "font-normal text-[#3c414b] hover:bg-[rgba(17,24,39,0.045)]",
  );
}

function NavLockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function PortalSidebar({
  definition,
  subscriptionTier,
  subtitle,
  initialCollapsed = false,
  residentNavStage,
  smsUiEnabled = false,
}: {
  definition: PortalDefinition;
  subscriptionTier?: "free" | "paid" | null;
  /** Header badge under "Axis": manager plan (Free/Pro/Business) or portal role. */
  subtitle?: string;
  initialCollapsed?: boolean;
  /** Resident lifecycle stage — drives bottom bar tabs and section locks. */
  residentNavStage?: ResidentPortalNavStage;
  /** Server-resolved SMS Communication UI flag — gates the Communication badge's SMS-notice handling. */
  smsUiEnabled?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isClient = useIsClient();
  const showNativeChrome = useNativeChrome();
  const isSmallViewport = useIsSmallPortalViewport();
  // Native app OR a phone-width browser — same bottom-nav chrome in both; only
  // the desktop (`lg:`) sidebar differs. Cross-portal full-navigation stays
  // native-only below (a WebView-specific routing quirk, not a viewport one).
  const showMobileNav = showNativeChrome || isSmallViewport;
  const navigate = usePortalNavigate();
  const session = usePortalSession();
  const { sections: visibleSections, restrictedSections } = useCoManagerNavSections(
    definition,
    session.userId,
  );
  const navCounts = usePortalNavCounts(definition.kind, smsUiEnabled);
  // The collapse control lives in the top strip; both read one shared store.
  const collapsed = useSyncExternalStore(
    subscribePortalSidebarCollapsed,
    () => getPortalSidebarCollapsed(initialCollapsed),
    () => initialCollapsed,
  );
  const [expandableNavOpen, setExpandableNavOpen] = useState<Record<string, boolean>>({});
  // Group headings collapse; the closed set persists per portal (best effort).
  const groupsStorageKey = `portal-nav-closed-groups:${definition.kind}`;
  const [closedGroups, setClosedGroups] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(groupsStorageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(parsed)) setClosedGroups(parsed.filter((v): v is string => typeof v === "string"));
    } catch {
      /* storage unavailable: every group stays open */
    }
  }, [groupsStorageKey]);
  const toggleGroup = useCallback(
    (id: string) => {
      setClosedGroups((prev) => {
        const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
        try {
          window.localStorage.setItem(groupsStorageKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [groupsStorageKey],
  );

  const activeSection = useMemo(() => {
    const parts = pathname.split("/").filter(Boolean);
    return parts[1] ?? "dashboard";
  }, [pathname]);

  const navItems = useMemo(() => {
    return buildPortalNavItems(definition, visibleSections, showNativeChrome, residentNavStage);
  }, [definition, residentNavStage, visibleSections, showNativeChrome]);

  const activeSectionSubTab = useMemo(() => {
    const parts = pathname.split("/").filter(Boolean);
    if (activeSection === "payments") {
      const paymentsIdx = parts.indexOf("payments");
      const tab = parts[paymentsIdx + 1];
      return tab === "incoming" || tab === "outgoing" ? tab : "incoming";
    }
    return null;
  }, [activeSection, pathname]);

  useEffect(() => {
    if (activeSection === "payments" || activeSection === "applications") {
      setExpandableNavOpen((prev) => ({ ...prev, [activeSection]: true }));
    }
  }, [activeSection]);

  const isNavItemActive = useCallback(
    (item: PortalSidebarNavItem) => {
      if (activeSection !== item.section) return false;
      if (item.subItems?.length) {
        return item.subItems.some((sub) => sub.sectionTabId === activeSectionSubTab);
      }
      if (item.sectionTabId) return item.sectionTabId === activeSectionSubTab;
      return true;
    },
    [activeSectionSubTab, activeSection],
  );

  const isSubNavActive = useCallback(
    (section: string, sub: PortalSidebarNavSubItem) =>
      activeSection === section && sub.sectionTabId === activeSectionSubTab,
    [activeSectionSubTab, activeSection],
  );

  const resolveNavItemHref = useCallback((item: PortalSidebarNavItem) => {
    if (!item.subItems?.length) return item.href;
    const activeSub = item.subItems.find((sub) => sub.sectionTabId === activeSectionSubTab);
    return activeSub?.href ?? item.subItems[0]?.href ?? item.href;
  }, [activeSectionSubTab]);

  const navGroups = useMemo(() => groupNavItems(definition.kind, navItems), [definition.kind, navItems]);
  useEffect(() => {
    syncPortalSidebarCollapsedAttribute(collapsed);
  }, [collapsed]);

  const showNavIcons =
    definition.kind === "admin" ||
    definition.kind === "pro" ||
    definition.kind === "resident" ||
    definition.kind === "manager" ||
    definition.kind === "vendor";

  // Locks apply to managers AND residents; `portalNavLockKind` only decides what
  // a locked row DOES when clicked — `upsell` (manager free tier), `notice`
  // (resident feature controlled by the manager's plan), or `inert` (resident
  // lifecycle stage not reached). See src/lib/portals/nav-locks.ts.
  // Every surface below — desktop list, collapsed rail, mobile strip, bottom
  // bar, More sheet — must honour the same split.
  const isSectionLocked = useCallback(
    (section: string) =>
      portalNavSectionLocked({
        kind: definition.kind,
        section,
        subscriptionTier,
        residentNavStage,
        coManagerRestricted: restrictedSections.has(section),
      }),
    [definition.kind, residentNavStage, subscriptionTier, restrictedSections],
  );

  // Must take the SAME inputs as `isSectionLocked`. If one sees the co-manager
  // restriction and the other does not, a locked row still renders as a live
  // link into a section the server bounces — which reads as a broken tab.
  const isSectionLockNavigable = useCallback(
    (section: string) =>
      portalNavLockNavigable({
        kind: definition.kind,
        section,
        subscriptionTier,
        residentNavStage,
        coManagerRestricted: restrictedSections.has(section),
      }),
    [definition.kind, residentNavStage, subscriptionTier, restrictedSections],
  );

  const nativeBottomNavSplit = useMemo(
    () =>
      showMobileNav && nativeBottomBarEnabledForKind(definition.kind)
        ? splitNativeBottomNavItems(navItems, definition.kind, residentNavStage)
        : { primary: [], overflow: [] },
    [definition.kind, navItems, residentNavStage, showMobileNav],
  );

  const nativeBottomNavItems = useMemo(() => {
    const primary = nativeBottomNavSplit.primary;
    // Resident lifecycle tabs stay visible while locked so the bar can show
    // Lease / Payments before approval and Services after signing.
    if (definition.kind === "resident") return primary;
    return primary.filter((item) => !isSectionLocked(item.section));
  }, [definition.kind, nativeBottomNavSplit, isSectionLocked]);
  const showMoreTab = showMobileNav && nativeBottomNavShowMoreTab(definition.kind, navItems);
  // A record page no longer has a bottom bar of its own (PLAN-0921-1029) —
  // this bar is never hidden on its account any more.
  const showBottomNavBar = showMobileNav && isClient && (nativeBottomNavItems.length > 0 || showMoreTab);
  const moreTabActive = !nativeBottomNavItems.some((item) => isNavItemActive(item));
  const [sectionsSheetOpen, setSectionsSheetOpen] = useState(false);
  const [bottomNavEl, setBottomNavEl] = useState<HTMLElement | null>(null);
  const bottomNavScrollRef = useRef<HTMLDivElement>(null);
  const topNavScrollRef = useRef<HTMLDivElement>(null);
  const bottomNavTouchRef = useRef<{ x: number; y: number } | null>(null);

  // Latest values for the swipe-page gesture handlers below, which are attached
  // imperatively (outside React's render cycle) and must always read current data.
  const swipeOrderRef = useRef<{ section: string; href: string }[]>([]);
  const activeSectionRef = useRef(activeSection);
  const contentTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const pendingSwipeEnterRef = useRef<"left" | "right" | null>(null);

  useEffect(() => {
    swipeOrderRef.current = nativeBottomNavItems;
  }, [nativeBottomNavItems]);

  useEffect(() => {
    activeSectionRef.current = activeSection;
  }, [activeSection]);

  useEffect(() => {
    return observeNativeBottomNavInset(bottomNavEl, showMobileNav);
  }, [bottomNavEl, showMobileNav]);

  // Apple-style paged swipe between the fixed bar's main tabs — a horizontal
  // touch gesture on the page content pages to the adjacent primary tab, kept in
  // sync with the bar since navigation drives `activeSection` the same as a tap.
  useEffect(() => {
    if (!showMobileNav) return;
    const contentEl = document.getElementById(PORTAL_MAIN_CONTENT_ID);
    if (!contentEl) return;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      contentTouchStartRef.current = { x: touch.clientX, y: touch.clientY };
    };

    const onTouchEnd = (e: TouchEvent) => {
      const start = contentTouchStartRef.current;
      contentTouchStartRef.current = null;
      const touch = e.changedTouches[0];
      if (!start || !touch) return;

      const direction = resolveSwipePageDirection({
        startX: start.x,
        startY: start.y,
        endX: touch.clientX,
        endY: touch.clientY,
      });
      if (!direction) return;

      const order = swipeOrderRef.current.map((item) => item.section);
      const adjacent = adjacentPrimarySection(order, activeSectionRef.current, direction);
      if (!adjacent) return;
      const href = swipeOrderRef.current.find((item) => item.section === adjacent)?.href;
      if (!href) return;

      pendingSwipeEnterRef.current = direction;
      void playSwipeExit(contentEl, direction).then(() => navigate(href));
    };

    contentEl.addEventListener("touchstart", onTouchStart, { passive: true });
    contentEl.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      contentEl.removeEventListener("touchstart", onTouchStart);
      contentEl.removeEventListener("touchend", onTouchEnd);
      resetSwipeTransform(contentEl);
    };
  }, [showMobileNav, navigate]);

  // Once the swiped-to tab's content has actually mounted (pathname settled),
  // play the entrance half of the slide from the opposite edge.
  useEffect(() => {
    const direction = pendingSwipeEnterRef.current;
    if (!direction) return;
    pendingSwipeEnterRef.current = null;
    const contentEl = document.getElementById(PORTAL_MAIN_CONTENT_ID);
    if (!contentEl) return;
    playSwipeEnter(contentEl, direction);
  }, [pathname]);

  useEffect(() => {
    if (showNativeChrome) return;
    const strip = topNavScrollRef.current;
    if (!strip) return;
    const activeEl = strip.querySelector<HTMLElement>(`[data-mobile-nav-section="${activeSection}"]`);
    activeEl?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [activeSection, navItems, showNativeChrome]);

  // The swipe-up "More" sheet is the full section index — every section, not just
  // the ones outside the fixed bar. Primary-bar sections (e.g. Documents) are
  // deliberately listed here too so there's always one comprehensive place to
  // find anything, alongside their one-tap bar shortcut.
  // The More tab carries the to-do counts of the sections that live only
  // inside the sheet (Leases, Tasks, Services…) so a phone still sees them;
  // sections with their own bar tab badge themselves.
  const moreTabCount = useMemo(() => {
    const onBar = new Set(nativeBottomNavItems.map((item) => item.section));
    return navItems
      .filter((item) => !onBar.has(item.section) && !isHiddenFromMobileNav(definition.kind, item.section))
      .filter((item) => !isSectionLocked(item.section))
      .reduce((sum, item) => sum + (navCounts[item.section]?.count ?? 0), 0);
  }, [definition.kind, isSectionLocked, navCounts, navItems, nativeBottomNavItems]);

  const moreSheetItems: PortalMoreNavItem[] = useMemo(() => {
    const ordered = orderNativeBottomNavItems(navItems, definition.kind);
    return ordered
      .filter((item) => !isHiddenFromMobileNav(definition.kind, item.section))
      .map((item) =>
        item.subItems?.length
          ? {
              // A section with sub-tabs (Payments) nests them under its own
              // row — the sheet used to flatten these into separate top-level
              // rows ("Incoming", "Outgoing") that lost the "Payments"
              // context the desktop sidebar keeps (PLAN-0920-1058 area 1d).
              section: item.section,
              label: item.label,
              href: item.href,
              locked: isSectionLocked(item.section),
              lockedNavigable: isSectionLockNavigable(item.section),
              count: navCounts[item.section]?.count ?? 0,
              countTone: navCounts[item.section]?.tone ?? "muted",
              subItems: item.subItems.map((sub) => ({
                section: item.section,
                sectionTabId: sub.sectionTabId,
                label: sub.label,
                href: sub.href,
                locked: isSectionLocked(item.section),
                lockedNavigable: isSectionLockNavigable(item.section),
                // The section's to-do count belongs to the section heading;
                // repeating it on every sub-tab read as two separate numbers.
              })),
            }
          : {
              section: item.section,
              label: item.label,
              href: item.href,
              locked: isSectionLocked(item.section),
              lockedNavigable: isSectionLockNavigable(item.section),
              count: navCounts[item.section]?.count ?? 0,
              countTone: navCounts[item.section]?.tone ?? "muted",
            },
      );
  }, [navItems, definition.kind, navCounts, isSectionLocked, isSectionLockNavigable]);

  const mobileTopStripItems = useMemo(
    () =>
      orderNativeBottomNavItems(
        navItems.filter(
          (s) => !isHiddenFromMobileNav(definition.kind, s.section) && s.section !== "profile",
        ),
        definition.kind,
      ),
    [navItems, definition.kind],
  );

  const isWorkspacePortal = definition.kind === "pro" || definition.kind === "manager";

  const lockAriaLabel = (label: string, locked: boolean, section?: string) => {
    if (!locked) return label;
    if (definition.kind === "resident" && residentNavStage && section) {
      const reason = residentNavLockReason(section, residentNavStage);
      if (reason) return `${label}: ${reason}`;
    }
    return definition.kind === "resident"
      ? `${label}: unavailable on your property's Free plan`
      : `${label}: locked on Pro or Business`;
  };

  const renderMobileNavLink = (
    s: PortalSidebarNavItem,
    variant: "top" | "bottom",
  ) => {
    const href = resolveNavItemHref(s);
    const active = isNavItemActive(s);
    const locked = isSectionLocked(s.section);
    // Inert locks must not navigate anywhere: the server bounces the request
    // straight back home, which reads as a tab that silently fails.
    const inert = locked && !isSectionLockNavigable(s.section);
    const count = navCounts[s.section]?.count ?? 0;
    const tone = navCounts[s.section]?.tone ?? "muted";

    if (variant === "bottom") {
      // The bar says what the sidebar says — Dashboard stays Dashboard.
      const bottomLabel = s.label;
      return (
        <Link
          key={`${s.section}-${s.sectionTabId ?? "default"}`}
          href={inert ? "#" : href}
          data-native-nav-section={s.section}
          data-attr={`bottom-nav-${s.section}${s.sectionTabId ? `-${s.sectionTabId}` : ""}`}
          prefetch={inert ? false : portalMobileLinkPrefetchEnabled()}
          aria-disabled={inert ? true : undefined}
          onClick={(e) => {
            if (inert) {
              e.preventDefault();
              return;
            }
            portalNavClick(router, href, {
              preferFullNavigation: showNativeChrome && isCrossPortalNavigation(pathname, href),
            })(e);
          }}
          className={`${PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS} ${
            active ? "text-primary" : "text-muted"
          }`}
          aria-label={lockAriaLabel(bottomLabel, locked, s.section)}
          aria-current={active ? "page" : undefined}
        >
          {/* The active tab is the FILLED glyph (PortalNavIcon `active`); no underline. */}
          {showNavIcons ? (
            <span
              className={`${PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS} transition-opacity duration-200 ${
                active ? "opacity-100" : locked ? "opacity-45" : "opacity-60"
              }`}
              aria-hidden
            >
              <PortalNavIcon
                section={s.section}
                className={PORTAL_NATIVE_BOTTOM_NAV_ICON_CLASS}
                active={active}
              />
              {/* Only an alert-tone badge (unread mail, overdue) badges a bottom tab; quiet pending counts belong to the sidebar. */}
              {!locked && count > 0 && tone === "alert" ? (
                <span className="absolute -top-1 -right-1.5">
                  <PortalNavCountBadge count={count} tone="alert" />
                </span>
              ) : null}
            </span>
          ) : (
            <span className={PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS} aria-hidden />
          )}
          <span className={`${PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS} ${active ? "text-primary" : "text-muted"}`}>
            {bottomLabel}
          </span>
        </Link>
      );
    }

    return (
      <Link
        key={`${s.section}-${s.sectionTabId ?? "default"}`}
        href={inert ? "#" : href}
        data-mobile-nav-section={s.section}
        data-mobile-nav-section-tab={s.sectionTabId}
        prefetch={inert ? false : portalMobileLinkPrefetchEnabled()}
        aria-disabled={inert ? true : undefined}
        onClick={(e) => {
          if (inert) {
            e.preventDefault();
            return;
          }
          portalNavClick(router, href)(e);
        }}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-[14px] px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition sm:text-[13px] ${
          inert ? "cursor-not-allowed " : ""
        }${
          active
            ? "bg-[var(--glass-fill)] text-foreground shadow-[inset_0_0_0_1px_var(--glass-border)] ring-1 ring-primary/20 [html[data-theme=light]_&]:bg-[var(--portal-active-bg,var(--card))] [html[data-theme=light]_&]:font-bold [html[data-theme=light]_&]:text-primary [html[data-theme=light]_&]:shadow-none"
            : locked
              ? "bg-accent/35 text-muted ring-1 ring-transparent [html[data-theme=dark]_&]:text-white/55"
              : "bg-accent/50 text-muted ring-1 ring-transparent hover:bg-accent hover:text-foreground [html[data-theme=dark]_&]:text-white/78"
        }`}
        aria-label={lockAriaLabel(s.label, locked, s.section)}
      >
        {showNavIcons ? (
          <span className={`shrink-0 ${locked ? "opacity-60" : "opacity-90"}`} aria-hidden>
            <PortalNavIcon section={s.section} sectionTabId={s.sectionTabId} active={active} />
          </span>
        ) : null}
        {s.label}
        {!locked ? <PortalNavCountBadge count={count} tone={tone} /> : null}
        {locked ? <NavLockIcon className="h-3 w-3 text-muted" /> : null}
      </Link>
    );
  };

  const renderExpandableNavGroup = (item: PortalSidebarNavItem) => {
    const locked = isSectionLocked(item.section);
    const count = navCounts[item.section]?.count ?? 0;
    const tone = navCounts[item.section]?.tone ?? "muted";
    const groupActive = isNavItemActive(item);
    const expanded = expandableNavOpen[item.section] ?? false;
    const subnavId = `portal-${item.section}-subnav`;
    const unread = !locked && tone === "alert" && count > 0;

    return (
      <div key={`${item.section}-group`} className="flex flex-col gap-px">
        <button
          type="button"
          onClick={() =>
            setExpandableNavOpen((prev) => ({ ...prev, [item.section]: !expanded }))
          }
          aria-expanded={expanded}
          aria-controls={subnavId}
          className={cn(navLinkClass(groupActive, locked, unread), "w-full border-0 bg-transparent text-left")}
        >
          <span className="flex min-w-0 flex-1 items-center gap-[9px]">
            {showNavIcons ? (
              <PortalNavIcon section={item.section} className="size-4 shrink-0" strokeWidth={1.75} />
            ) : null}
            <span className="min-w-0 truncate">{item.label}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {!locked ? <PortalNavCountBadge count={count} tone={tone} /> : null}
            {locked ? <NavLockIcon className="h-3.5 w-3.5 text-muted" /> : null}
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted/70" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted/70" aria-hidden />
            )}
          </span>
        </button>
        {expanded ? (
          <div id={subnavId} className="ml-3 flex flex-col gap-px border-l border-border pl-2">
            {item.subItems!.map((sub) => {
              const active = isSubNavActive(item.section, sub);
              const subLocked = locked;
              const subBody = (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {showNavIcons ? (
                    <PortalNavIcon
                      section={item.section}
                      sectionTabId={sub.sectionTabId}
                      className="size-[15px] shrink-0"
                      strokeWidth={1.75}
                    />
                  ) : null}
                  <span className="min-w-0 truncate">{sub.label}</span>
                </span>
              );
              if (subLocked && !isSectionLockNavigable(item.section)) {
                return (
                  <span
                    key={sub.sectionTabId}
                    className={cn(navLinkClass(false, true), "cursor-not-allowed")}
                    title={lockAriaLabel(sub.label, true, item.section)}
                    aria-label={lockAriaLabel(sub.label, true, item.section)}
                    role="link"
                    aria-disabled="true"
                  >
                    {subBody}
                  </span>
                );
              }
              return (
                <Link
                  key={sub.sectionTabId}
                  href={sub.href}
                  prefetch={portalBackgroundPrefetchEnabled()}
                  onMouseEnter={
                    portalIntentPrefetchEnabled()
                      ? () => {
                          prefetchPortalHref(router, sub.href);
                          for (const href of sub.prefetchHrefs) prefetchPortalHref(router, href);
                        }
                      : undefined
                  }
                  className={navLinkClass(active, subLocked)}
                  aria-label={lockAriaLabel(sub.label, subLocked, item.section)}
                  aria-current={active ? "page" : undefined}
                >
                  {subBody}
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  const renderDesktopLink = (s: PortalSidebarNavItem) => {
    if (s.subItems?.length) return renderExpandableNavGroup(s);
    const active = isNavItemActive(s);
    const locked = isSectionLocked(s.section);
    const count = navCounts[s.section]?.count ?? 0;
    const tone = navCounts[s.section]?.tone ?? "muted";
    // An unread / overdue (alert) count makes the row bold ink with a red badge.
    const unread = !locked && tone === "alert" && count > 0;
    const body = (
      <>
        <span className="flex min-w-0 flex-1 items-center gap-[9px]">
          {showNavIcons ? (
            <PortalNavIcon section={s.section} sectionTabId={s.sectionTabId} className="size-4 shrink-0" strokeWidth={1.75} />
          ) : null}
          <span className="min-w-0 truncate">{s.label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {!locked ? <PortalNavCountBadge count={count} tone={tone} /> : null}
          {locked ? <NavLockIcon className="h-3.5 w-3.5 text-muted" /> : null}
        </span>
      </>
    );
    if (locked && !isSectionLockNavigable(s.section)) {
      // `title` as well as `aria-label`: an inert row has no destination and no
      // visible reason text, so without a tooltip a SIGHTED user taps a dead
      // row and learns nothing — the lock reason ("Available after your
      // application is approved", "Available after your lease is signed") only
      // ever reached assistive tech. Plan locks are navigable notices and do
      // not enter this branch.
      return (
        <span
          key={`${s.section}-${s.sectionTabId ?? "default"}`}
          className={cn(navLinkClass(false, true), "cursor-not-allowed")}
          title={lockAriaLabel(s.label, true, s.section)}
          aria-label={lockAriaLabel(s.label, true, s.section)}
          role="link"
          aria-disabled="true"
        >
          {body}
        </span>
      );
    }
    return (
      <Link
        key={`${s.section}-${s.sectionTabId ?? "default"}`}
        href={s.href}
        prefetch={portalBackgroundPrefetchEnabled()}
        onMouseEnter={
          portalIntentPrefetchEnabled()
            ? () => {
                prefetchPortalHref(router, s.href);
                for (const href of s.prefetchHrefs) prefetchPortalHref(router, href);
              }
            : undefined
        }
        className={navLinkClass(active, locked, unread)}
        aria-label={lockAriaLabel(s.label, locked, s.section)}
        aria-current={active ? "page" : undefined}
      >
        {body}
      </Link>
    );
  };

  const brand = portalBrandCopy(definition.kind);
  const rawSubtitle = subtitle?.trim() || brand.subtitle;
  // Property portal: show the portal name instead of the billing tier.
  const headerSubtitle = rawSubtitle === "Pro" || rawSubtitle === "Business" ? "Property" : rawSubtitle;

  const workspaces = useWorkspaces();
  const activeHouseCount = workspaces?.active?.livePropertyCount ?? null;
  // "Property · 2 houses" from the data the workspace switcher already holds; the
  // other portals just say who they are.
  const headerSubLine =
    isWorkspacePortal && workspaces?.active
      ? `${headerSubtitle} · ${activeHouseCount ?? 0} ${activeHouseCount === 1 ? "house" : "houses"}`
      : headerSubtitle;

  // New message: the existing Communication compose, reached through the
  // communication route's own `?compose=1` entry (manager, vendor, resident).
  const communicationLocked = isSectionLocked("communication") && !isSectionLockNavigable("communication");
  const hasCommunication = definition.sections.some((section) => section.section === "communication");
  const newMessageHref = `${definition.basePath}/communication/active?compose=1`;
  const showNewMessage = definition.kind !== "admin" && hasCommunication && !communicationLocked;

  const headingClass =
    "flex w-full items-center gap-1 rounded-[6px] border-0 bg-transparent px-2 py-[3px] text-left text-[12px] font-semibold text-[#7a808b] transition-colors hover:bg-[rgba(17,24,39,0.045)]";

  const desktopAside = (
    <aside
      aria-hidden={collapsed || undefined}
      className={cn(
        "relative z-40 hidden h-full min-h-0 w-[248px] shrink-0 self-stretch flex-col overflow-hidden border-r border-border bg-[var(--portal-sidebar-bg,#f6f7f9)]",
        // Collapsed sidebar = rail + content only.
        collapsed ? "lg:hidden" : "lg:flex",
      )}
      data-slot="portal-sidebar"
    >
      <div className="flex shrink-0 items-start gap-1.5 pb-2 pl-3.5 pr-2.5 pt-3">
        <div className="min-w-0 flex-1">
          {isWorkspacePortal ? (
            <WorkspaceSwitcher variant="sidebar" />
          ) : (
            <p className="truncate text-[16px] font-bold tracking-[-0.02em] text-foreground">PropLane</p>
          )}
          <p className="mt-0.5 flex items-center gap-[5px] text-[12px] text-[#7a808b]">
            <b aria-hidden className="inline-block size-1.5 rounded-full bg-[#22a06b]" />
            <span className="min-w-0 truncate">{headerSubLine}</span>
          </p>
        </div>
        {showNewMessage ? (
          <button
            type="button"
            onClick={() => navigate(newMessageHref)}
            aria-label="New message"
            title="New message"
            data-attr="portal-sidebar-new-message"
            className="grid size-[30px] shrink-0 place-items-center rounded-[7px] border border-[rgba(17,24,39,0.13)] bg-white text-[#3c414b] outline-none transition hover:bg-[#f7f8fa] focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <SquarePen className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 pb-3 pt-1 [scrollbar-width:thin]"
        aria-label="Portal sections"
      >
        {navGroups.map((group) => {
          const closed = Boolean(group.label) && closedGroups.includes(group.id);
          // The active row stays visible even inside a collapsed group.
          const visibleItems = closed ? group.items.filter((item) => isNavItemActive(item)) : group.items;
          return (
            <div key={group.id} className={cn("flex flex-col gap-px", group.label && "mt-3")} data-nav-group={group.id}>
              {group.label ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!closed}
                  data-attr={`portal-nav-group-${group.id}`}
                  className={headingClass}
                >
                  <ChevronDown
                    className={cn("size-3 shrink-0 transition-transform duration-150", closed && "-rotate-90")}
                    strokeWidth={2}
                    aria-hidden
                  />
                  {group.label}
                </button>
              ) : null}
              {visibleItems.map((s) => renderDesktopLink(s))}
            </div>
          );
        })}
      </nav>
    </aside>
  );

  return (
    <>
      {desktopAside}

      <div className="shrink-0 lg:hidden">
        <div className={PORTAL_MOBILE_CHROME_CLASS}>
          <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
            <Link
              href="/"
              prefetch
              aria-label="PropLane home"
              className="shrink-0 transition-opacity hover:opacity-90"
            >
              <AxisLogoMark size="compact" />
            </Link>
            <nav
              ref={topNavScrollRef}
              className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              aria-label="Portal sections"
            >
              {mobileTopStripItems.map((s) => renderMobileNavLink(s, "top"))}
            </nav>
          </div>
        </div>
      </div>

      <PortalNativeMoreSheet
        open={sectionsSheetOpen}
        onOpenChange={setSectionsSheetOpen}
        items={moreSheetItems}
        kind={definition.kind}
        activeSection={activeSection}
        activeSectionTabId={activeSectionSubTab}
        showNavIcons={showNavIcons}
      />

      {showBottomNavBar
        ? createPortal(
            <nav
              ref={setBottomNavEl}
              className={`${PORTAL_NATIVE_BOTTOM_NAV_CLASS} relative`}
              aria-label="Portal sections"
              onTouchStart={(e) => {
                const touch = e.touches[0];
                if (!touch) return;
                bottomNavTouchRef.current = { x: touch.clientX, y: touch.clientY };
              }}
              onTouchEnd={(e) => {
                const start = bottomNavTouchRef.current;
                bottomNavTouchRef.current = null;
                const touch = e.changedTouches[0];
                if (!start || !touch) return;
                if (
                  shouldOpenNativeSectionsSheet({
                    startX: start.x,
                    startY: start.y,
                    endX: touch.clientX,
                    endY: touch.clientY,
                  })
                ) {
                  setSectionsSheetOpen(true);
                }
              }}
            >
              {/*
                Hit target is ONLY the centered handle strip — never full-bar
                inset-x-0 + h-11 (PRP-366 / PRP-349). That overlay sat above the
                tabs and stole every thumb tap.
              */}
              <button
                type="button"
                className="portal-native-bottom-nav-pull absolute left-1/2 top-0 z-10 flex h-4 w-14 -translate-x-1/2 items-start justify-center border-0 bg-transparent p-0"
                aria-label="Show all sections"
                onClick={() => setSectionsSheetOpen(true)}
              >
                {showMoreTab ? null : (
                  <span className="portal-native-bottom-nav-pull-handle mt-0.5" aria-hidden />
                )}
              </button>
              <div
                ref={bottomNavScrollRef}
                className="portal-native-bottom-nav-scroll relative z-0 grid w-full min-w-0 pt-1"
                style={{
                  gridTemplateColumns: `repeat(${nativeBottomNavItems.length + (showMoreTab ? 1 : 0)}, minmax(0, 1fr))`,
                }}
                aria-label="Portal sections"
              >
                {nativeBottomNavItems.map((s) => renderMobileNavLink(s, "bottom"))}
                {showMoreTab ? (
                  <PortalNativeMoreNavButton
                    active={moreTabActive}
                    count={moreTabCount}
                    onClick={() => setSectionsSheetOpen(true)}
                  />
                ) : null}
              </div>
            </nav>,
            document.body,
          )
        : null}
    </>
  );
}
