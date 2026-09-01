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
import { portalBackgroundPrefetchEnabled, portalMobileLinkPrefetchEnabled } from "@/lib/portal-nav-prefetch";
import {
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MOBILE_CHROME_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ICON_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS,
} from "@/lib/portal-layout-classes";
import { prefetchPortalPanelChunks } from "@/lib/portal-panel-prefetch";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/portal-sidebar-cookie";
import { groupNavItems, isAppNavHiddenInNativeShell, isHiddenFromMobileNav } from "@/lib/portals/nav-groups";
import { PAYMENT_BUCKETS } from "@/lib/portal-detail-routes";
import type { PortalDefinition, PortalKind } from "@/lib/portal-types";
import { cn } from "@/lib/utils";
import { ChevronsLeft, ChevronsRight, ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsClient } from "@/hooks/use-is-client";

function hrefForSection(def: PortalDefinition, section: string) {
  const meta = def.sections.find((s) => s.section === section);
  if (!meta) return def.basePath;
  if (section === "communication") {
    if (def.basePath === "/portal" || def.basePath === "/resident" || def.basePath === "/vendor") {
      return `${def.basePath}/communication/active`;
    }
    return `${def.basePath}/communication/inbox/unopened`;
  }
  if (!meta.tabs.length) return `${def.basePath}/${section}`;
  // Most tabbed sections use `/section/tab` only. Bucketed queues (applications,
  // tours, payments) declare `tabs: []` in the registry and own their own href
  // builders — do not append `/pending` here or Finances/Documents 404.
  if (section === "tasks") return `${def.basePath}/tasks`;
  return `${def.basePath}/${section}/${meta.tabs[0].id}`;
}

type PortalSidebarNavSubItem = {
  sectionTabId: string;
  label: string;
  href: string;
  prefetchHrefs: string[];
};

type PortalSidebarNavItem = {
  section: string;
  label: string;
  href: string;
  prefetchHrefs: string[];
  sectionTabId?: string;
  subItems?: PortalSidebarNavSubItem[];
};

function buildPortalNavItems(
  definition: PortalDefinition,
  visibleSections: PortalDefinition["sections"],
  showNativeChrome: boolean,
  residentNavStage: ResidentPortalNavStage | undefined,
): PortalSidebarNavItem[] {
  return visibleSections
    .filter((section) => {
      if (isAppNavHiddenInNativeShell(definition.kind, section.section, showNativeChrome)) {
        return false;
      }
      if (
        definition.kind === "resident" &&
        residentNavStage &&
        !residentNavSectionVisibleInNav(section.section, residentNavStage)
      ) {
        return false;
      }
      return true;
    })
    .flatMap((section) => {
      if (section.section === "background-checks") {
        return [];
      }
      if (
        section.section === "payments" &&
        section.tabs.some((tab) => tab.id === "incoming" || tab.id === "outgoing")
      ) {
        const tabs = section.tabs.filter((tab) => tab.id === "incoming" || tab.id === "outgoing");
        return [
          {
            section: section.section,
            label: section.label,
            href: `${definition.basePath}/payments/incoming/pending`,
            prefetchHrefs: PAYMENT_BUCKETS.flatMap((bucket) =>
              tabs.map((tab) => `${definition.basePath}/payments/${tab.id}/${bucket}`),
            ),
            subItems: tabs.map((tab) => ({
              sectionTabId: tab.id,
              label: tab.label,
              href: `${definition.basePath}/payments/${tab.id}/pending`,
              prefetchHrefs: PAYMENT_BUCKETS.map(
                (bucket) => `${definition.basePath}/payments/${tab.id}/${bucket}`,
              ),
            })),
          },
        ];
      }
      if (
        section.section === "teams" &&
        section.tabs.some((tab) => tab.id === "managers" || tab.id === "vendors")
      ) {
        const tabs = section.tabs.filter((tab) => tab.id === "managers" || tab.id === "vendors");
        return [
          {
            section: section.section,
            label: section.label,
            href: `${definition.basePath}/teams/managers`,
            prefetchHrefs: tabs.map((tab) => `${definition.basePath}/teams/${tab.id}`),
            subItems: tabs.map((tab) => ({
              sectionTabId: tab.id,
              label: tab.label,
              href: `${definition.basePath}/teams/${tab.id}`,
              prefetchHrefs: [`${definition.basePath}/teams/${tab.id}`],
            })),
          },
        ];
      }
      if (section.section === "applications") {
        const appBase = `${definition.basePath}/applications/pending`;
        if (definition.kind === "resident") {
          return [
            {
              section: section.section,
              label: section.label,
              href: appBase,
              prefetchHrefs: [appBase],
            },
          ];
        }
        const bgBase = `${definition.basePath}/background-checks/pending_review`;
        return [
          {
            section: section.section,
            label: section.label,
            href: appBase,
            prefetchHrefs: [appBase, bgBase],
            subItems: [
              {
                sectionTabId: "application",
                label: "Application",
                href: appBase,
                prefetchHrefs: [appBase],
              },
              {
                sectionTabId: "background-check",
                label: "Background check",
                href: bgBase,
                prefetchHrefs: [bgBase],
              },
            ],
          },
        ];
      }
      return [
        {
          section: section.section,
          label: section.label,
          href: hrefForSection(definition, section.section),
          prefetchHrefs: section.tabs.length
            ? section.tabs.map((tab) => `${definition.basePath}/${section.section}/${tab.id}`)
            : [`${definition.basePath}/${section.section}`],
        },
      ];
    });
}

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

function navLinkClass(active: boolean, locked?: boolean) {
  return [
    "group relative flex min-h-8 items-center justify-between gap-2 rounded-[8px] px-2.5 py-1.5 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-150",
    active
      ? "bg-[var(--secondary)] text-foreground"
      : locked
        ? "text-muted/70 hover:bg-[var(--secondary)]/60 hover:text-muted"
        : "text-muted hover:bg-[var(--secondary)]/60 hover:text-foreground",
  ].join(" ");
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
}: {
  definition: PortalDefinition;
  subscriptionTier?: "free" | "paid" | null;
  /** Header badge under "Axis": manager plan (Free/Pro/Business) or portal role. */
  subtitle?: string;
  initialCollapsed?: boolean;
  /** Resident lifecycle stage — drives bottom bar tabs and section locks. */
  residentNavStage?: ResidentPortalNavStage;
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
  const navCounts = usePortalNavCounts(definition.kind);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [expandableNavOpen, setExpandableNavOpen] = useState<Record<string, boolean>>({});

  const activeSection = useMemo(() => {
    const parts = pathname.split("/").filter(Boolean);
    const section = parts[1] ?? "dashboard";
    if (section === "background-checks") return "applications";
    return section;
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
    if (activeSection === "teams") {
      const teamsIdx = parts.indexOf("teams");
      const tab = parts[teamsIdx + 1];
      return tab === "managers" || tab === "vendors" ? tab : "managers";
    }
    if (activeSection === "applications") {
      const bgIdx = parts.indexOf("background-checks");
      if (bgIdx >= 0) return "background-check";
      return "application";
    }
    return null;
  }, [activeSection, pathname]);

  useEffect(() => {
    if (activeSection === "payments" || activeSection === "teams" || activeSection === "applications") {
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
  const firstTrailingGroupIdx = useMemo(
    () => navGroups.findIndex((g) => g.id === "account" || g.id === "more"),
    [navGroups],
  );

  useEffect(() => {
    if (!portalBackgroundPrefetchEnabled()) return;
    prefetchPortalPanelChunks();
  }, []);

  useEffect(() => {
    if (collapsed) {
      document.documentElement.setAttribute("data-portal-sidebar-collapsed", "");
    } else {
      document.documentElement.removeAttribute("data-portal-sidebar-collapsed");
    }
  }, [collapsed]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      document.cookie = `${SIDEBAR_COLLAPSED_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  };

  const showNavIcons =
    definition.kind === "admin" ||
    definition.kind === "pro" ||
    definition.kind === "resident" ||
    definition.kind === "manager" ||
    definition.kind === "vendor";

  // Locks apply to managers AND residents; `portalNavLockKind` only decides what
  // a locked row DOES when clicked — `upsell` (manager free tier, still
  // navigates to the PortalTierPaywall upgrade page) vs `inert` (every resident
  // lock, nothing to buy). See src/lib/portals/nav-locks.ts for the reasoning.
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
  const showBottomNavBar =
    showMobileNav && isClient && (nativeBottomNavItems.length > 0 || showMoreTab);
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
  const moreSheetItems: PortalMoreNavItem[] = useMemo(() => {
    const ordered = orderNativeBottomNavItems(navItems, definition.kind);
    return ordered
      .filter((item) => !isHiddenFromMobileNav(definition.kind, item.section))
      .flatMap((item) =>
        item.subItems?.length
          ? item.subItems.map((sub) => ({
              section: item.section,
              sectionTabId: sub.sectionTabId,
              label: sub.label,
              href: sub.href,
              locked: isSectionLocked(item.section),
              lockedNavigable: isSectionLockNavigable(item.section),
              count: navCounts[item.section] ?? 0,
            }))
          : [
              {
                section: item.section,
                label: item.label,
                href: item.href,
                locked: isSectionLocked(item.section),
                lockedNavigable: isSectionLockNavigable(item.section),
                count: navCounts[item.section] ?? 0,
              },
            ],
      );
  }, [navItems, definition.kind, navCounts, isSectionLocked, isSectionLockNavigable]);

  const mobileTopStripItems = useMemo(
    () =>
      orderNativeBottomNavItems(
        navItems.filter((s) => !isHiddenFromMobileNav(definition.kind, s.section)),
        definition.kind,
      ),
    [navItems, definition.kind],
  );

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
    const count = navCounts[s.section] ?? 0;

    if (variant === "bottom") {
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
          aria-label={lockAriaLabel(s.label, locked, s.section)}
          aria-current={active ? "page" : undefined}
        >
          {active ? (
            <span
              className="absolute inset-x-[18%] top-0 h-0.5 rounded-full bg-primary"
              aria-hidden
            />
          ) : null}
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
              {!locked && count > 0 ? (
                <span className="absolute -top-1 -right-1.5">
                  <PortalNavCountBadge count={count} />
                </span>
              ) : null}
            </span>
          ) : (
            <span className={PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS} aria-hidden />
          )}
          <span className={`${PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS} ${active ? "text-primary" : "text-muted"}`}>
            {s.label}
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
            ? "bg-[var(--glass-fill)] text-foreground shadow-[inset_0_0_0_1px_var(--glass-border)] ring-1 ring-primary/20 [html[data-theme=light]_&]:bg-card [html[data-theme=light]_&]:shadow-[var(--shadow-sm)]"
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
        {!locked ? <PortalNavCountBadge count={count} /> : null}
        {locked ? <NavLockIcon className="h-3 w-3 text-muted" /> : null}
      </Link>
    );
  };

  const renderExpandableNavGroup = (item: PortalSidebarNavItem) => {
    const locked = isSectionLocked(item.section);
    const count = navCounts[item.section] ?? 0;
    const groupActive = isNavItemActive(item);
    const expanded = expandableNavOpen[item.section] ?? false;
    const subnavId = `portal-${item.section}-subnav`;

    return (
      <div key={`${item.section}-group`} className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() =>
            setExpandableNavOpen((prev) => ({ ...prev, [item.section]: !expanded }))
          }
          aria-expanded={expanded}
          aria-controls={subnavId}
          className={cn(
            navLinkClass(groupActive, locked),
            "w-full border-0 bg-transparent text-left",
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            {showNavIcons ? (
              <span className={groupActive ? "text-primary" : locked ? "opacity-60" : "opacity-80"} aria-hidden>
                <PortalNavIcon section={item.section} className="h-[17px] w-[17px] shrink-0" active={groupActive} />
              </span>
            ) : null}
            <span className="min-w-0 truncate">{item.label}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {!locked ? <PortalNavCountBadge count={count} /> : null}
            {locked ? <NavLockIcon className="h-3.5 w-3.5 text-muted" /> : null}
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted/70" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted/70" aria-hidden />
            )}
          </span>
        </button>
        {expanded ? (
          <div id={subnavId} className="ml-1 flex flex-col gap-1 border-l border-border/70 pl-2">
            {item.subItems!.map((sub) => {
            const active = isSubNavActive(item.section, sub);
            const subLocked = locked;
            const subBody = (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {showNavIcons ? (
                  <span className={active ? "text-primary" : subLocked ? "opacity-60" : "opacity-80"} aria-hidden>
                    <PortalNavIcon
                      section={item.section}
                      sectionTabId={sub.sectionTabId}
                      className="h-[15px] w-[15px] shrink-0"
                      active={active}
                    />
                  </span>
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
                  portalBackgroundPrefetchEnabled()
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
    const count = navCounts[s.section] ?? 0;
    const body = (
      <>
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          {showNavIcons ? (
            <span className={active ? "text-primary" : locked ? "opacity-60" : "opacity-80"} aria-hidden>
              <PortalNavIcon section={s.section} sectionTabId={s.sectionTabId} className="h-[17px] w-[17px] shrink-0" active={active} />
            </span>
          ) : null}
          <span className="min-w-0 truncate">{s.label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {!locked ? <PortalNavCountBadge count={count} /> : null}
          {locked ? <NavLockIcon className="h-3.5 w-3.5 text-muted" /> : null}
        </span>
      </>
    );
    if (locked && !isSectionLockNavigable(s.section)) {
      // `title` as well as `aria-label`: an inert row has no destination and no
      // visible reason text, so without a tooltip a SIGHTED user taps a dead
      // row and learns nothing — the lock reason ("Available after your
      // application is approved", "Available after your lease is signed") only
      // ever reached assistive tech. Applies to every resident lock, not one string.
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
          portalBackgroundPrefetchEnabled()
            ? () => {
                prefetchPortalHref(router, s.href);
                for (const href of s.prefetchHrefs) prefetchPortalHref(router, href);
              }
            : undefined
        }
        className={navLinkClass(active, locked)}
        aria-label={lockAriaLabel(s.label, locked, s.section)}
        aria-current={active ? "page" : undefined}
      >
        {body}
      </Link>
    );
  };

  const renderRailLink = (s: PortalSidebarNavItem) => {
    const href = resolveNavItemHref(s);
    const active = isNavItemActive(s);
    const locked = isSectionLocked(s.section);
    const count = navCounts[s.section] ?? 0;
    const railClass = cn(
      "relative grid h-9 w-9 place-items-center rounded-[8px] transition-colors duration-150",
      active
        ? "bg-[var(--secondary)] text-primary"
        : locked
          ? "cursor-not-allowed text-muted/60"
          : "text-muted hover:bg-[var(--secondary)]/60 hover:text-foreground",
    );
    const icon = (
      <>
        <PortalNavIcon section={s.section} sectionTabId={s.sectionTabId} className="h-[17px] w-[17px] shrink-0" active={active} />
        {!locked && count > 0 ? (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
        ) : null}
        {locked ? <NavLockIcon className="absolute right-0.5 top-0.5 h-2.5 w-2.5 text-muted" /> : null}
      </>
    );
    if (locked && !isSectionLockNavigable(s.section)) {
      return (
        <span
          key={`${s.section}-${s.sectionTabId ?? "default"}`}
          // The collapsed rail is icon-only, so `title={s.label}` dropped the
          // reason entirely — carry the same tooltip the expanded row shows.
          title={lockAriaLabel(s.label, true, s.section)}
          aria-label={lockAriaLabel(s.label, true, s.section)}
          aria-disabled="true"
          className={railClass}
        >
          {icon}
        </span>
      );
    }
    return (
      <Link
        key={`${s.section}-${s.sectionTabId ?? "default"}`}
        href={href}
        prefetch={portalBackgroundPrefetchEnabled()}
        onMouseEnter={
          portalBackgroundPrefetchEnabled()
            ? () => {
                prefetchPortalHref(router, href);
                for (const prefetchHref of s.prefetchHrefs) prefetchPortalHref(router, prefetchHref);
              }
            : undefined
        }
        title={s.label}
        aria-label={lockAriaLabel(s.label, locked, s.section)}
        aria-current={active ? "page" : undefined}
        className={railClass}
      >
        {icon}
      </Link>
    );
  };

  const brand = portalBrandCopy(definition.kind);
  const rawSubtitle = subtitle?.trim() || brand.subtitle;
  // Property portal: show the portal name instead of the billing tier.
  const headerSubtitle = rawSubtitle === "Pro" || rawSubtitle === "Business" ? "Property" : rawSubtitle;

  const desktopAside = (
    <aside
      className={cn(
        "relative z-40 hidden h-full min-h-0 shrink-0 self-stretch flex-col overflow-hidden border-r border-border bg-background glass-nav lg:flex",
        collapsed ? "w-[58px]" : "w-[224px]",
      )}
    >
      {collapsed ? (
        <div className="flex h-14 shrink-0 items-center justify-center border-b border-border">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            aria-expanded={false}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-muted transition-colors duration-150 hover:bg-[var(--secondary)]/60 hover:text-foreground"
          >
            <ChevronsRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-3">
          <Link
            href="/"
            prefetch
            aria-label="PropLane home"
            className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-90"
          >
            <AxisLogoMark size="compact" />
            <span className="min-w-0 leading-tight">
              <span className="block text-[14px] font-semibold tracking-[-0.02em] text-foreground">PropLane</span>
              <span className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--secondary)] px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-[0.11em] text-muted">
                <span className="h-1 w-1 shrink-0 rounded-full bg-primary" aria-hidden />
                {headerSubtitle}
              </span>
            </span>
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Collapse sidebar"
            aria-expanded
            className="ml-auto grid h-7 w-7 place-items-center rounded-[8px] text-muted transition-colors duration-150 hover:bg-[var(--secondary)]/60 hover:text-foreground"
          >
            <ChevronsLeft className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {collapsed ? (
        <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2 py-2.5" aria-label="Portal sections">
          {navGroups.map((group, i) => (
            <div
              key={group.id}
              className={cn("flex w-full flex-col items-center gap-1", i === firstTrailingGroupIdx && "mt-auto")}
            >
              {i > 0 ? <div className="my-1 h-px w-6 bg-border" aria-hidden /> : null}
              {group.items.map((s) => renderRailLink(s))}
            </div>
          ))}
        </nav>
      ) : (
        <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 py-2.5" aria-label="Portal sections">
          {navGroups.map((group, i) => (
            <div
              key={group.id}
              className={cn(
                "flex flex-col gap-px",
                i === firstTrailingGroupIdx && "mt-auto border-t border-border pt-2",
              )}
            >
              {group.label ? (
                <p className="px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted/60">
                  {group.label}
                </p>
              ) : null}
              {group.items.map((s) => renderDesktopLink(s))}
            </div>
          ))}
        </nav>
      )}
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
            >
              <button
                type="button"
                className="portal-native-bottom-nav-pull absolute inset-x-0 top-0 z-10 flex h-2.5 items-start justify-center border-0 bg-transparent p-0"
                aria-label="Show all sections"
                onClick={() => setSectionsSheetOpen(true)}
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
                {showMoreTab ? null : (
                  <span className="portal-native-bottom-nav-pull-handle mt-0.5" aria-hidden />
                )}
              </button>
              <div
                ref={bottomNavScrollRef}
                className="portal-native-bottom-nav-scroll grid w-full min-w-0 pt-1"
                style={{
                  gridTemplateColumns: `repeat(${nativeBottomNavItems.length + (showMoreTab ? 1 : 0)}, minmax(0, 1fr))`,
                }}
                aria-label="Portal sections"
              >
                {nativeBottomNavItems.map((s) => renderMobileNavLink(s, "bottom"))}
                {showMoreTab ? (
                  <PortalNativeMoreNavButton active={moreTabActive} onClick={() => setSectionsSheetOpen(true)} />
                ) : null}
              </div>
            </nav>,
            document.body,
          )
        : null}
    </>
  );
}
