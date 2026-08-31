"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getPortalScrollRoot,
  syncPortalDetailDestinationOffset,
  syncPortalMobileTopChrome,
} from "@/lib/portal-mobile-top-chrome";

type ListingSubnavMode = "page" | "modal" | "portal";

const NAVBAR_ID = "axis-public-navbar";
const PREVIEW_SCROLL_SELECTOR = "[data-listing-preview-scroll]";
const PREVIEW_SHELL_SELECTOR = "[data-listing-preview-shell]";
const LISTING_SECTIONS_ROOT_SELECTOR = "[data-listing-sections-root]";

const nav = [
  { id: "floor-plans", label: "Floor plans", shortLabel: "Floors" },
  { id: "lease-basics", label: "Lease basics", shortLabel: "Lease" },
  { id: "amenities", label: "Amenities", shortLabel: "Amenities" },
  { id: "bundles", label: "Bundles & leasing", shortLabel: "Bundles" },
  { id: "house-rules", label: "House rules", shortLabel: "Rules" },
  { id: "location", label: "Location", shortLabel: "Location" },
] as const;

function getListingSectionsRoot(subnavEl: HTMLElement | null): HTMLElement | null {
  return subnavEl?.closest<HTMLElement>(LISTING_SECTIONS_ROOT_SELECTOR) ?? null;
}

function getScrollRootFromSubnav(subnavEl: HTMLElement | null): HTMLElement | null {
  const nested = subnavEl?.closest<HTMLElement>(PREVIEW_SCROLL_SELECTOR);
  if (nested) return nested;
  const shell = subnavEl?.closest<HTMLElement>(PREVIEW_SHELL_SELECTOR);
  return shell?.querySelector<HTMLElement>(PREVIEW_SCROLL_SELECTOR) ?? null;
}

/** Height of the sticky portal mobile top bar (back + profile) above the listing subnav. */
function readPortalStickyTopInset(subnavEl: HTMLElement | null): number {
  return syncPortalMobileTopChrome(subnavEl);
}

function getSectionElement(id: string, mode: ListingSubnavMode, subnavEl: HTMLElement | null): HTMLElement | null {
  if (mode === "modal") {
    const root = getScrollRootFromSubnav(subnavEl);
    return root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null;
  }
  const listingRoot = getListingSectionsRoot(subnavEl);
  if (listingRoot) {
    return listingRoot.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null;
  }
  return document.getElementById(id);
}

function syncListingScrollStack(
  mode: ListingSubnavMode,
  subnavEl: HTMLElement | null,
  pinned = false,
): number {
  if (!subnavEl) return 128;
  const isNative =
    typeof document !== "undefined" && document.documentElement.hasAttribute("data-native");
  if (mode === "portal") {
    const chrome = readPortalStickyTopInset(subnavEl);
    const destOffset =
      typeof document !== "undefined"
        ? Number.parseFloat(
            getComputedStyle(getPortalScrollRoot(subnavEl) ?? document.documentElement).getPropertyValue(
              "--portal-detail-destination-offset",
            ),
          ) || 0
        : 0;
    const subnavInPropertyChrome = Boolean(
      subnavEl.closest("[data-portal-property-detail-chrome]"),
    );
    const subnavH = subnavInPropertyChrome ? 0 : subnavEl.offsetHeight;
    const stack = chrome + destOffset + subnavH + 12;
    const listingRoot = getListingSectionsRoot(subnavEl);
    listingRoot?.style.setProperty("--listing-sticky-stack", `${stack}px`);
    return stack;
  }
  if (mode === "modal") {
    const scrollRoot = getScrollRootFromSubnav(subnavEl);
    const listingRoot = scrollRoot?.querySelector<HTMLElement>(LISTING_SECTIONS_ROOT_SELECTOR);
    // Pinned preview subnav sits above the scroller — sections only need a small scroll margin.
    const stack = pinned ? 12 : subnavEl.offsetHeight + 12;
    scrollRoot?.style.setProperty("--listing-sticky-stack", `${stack}px`);
    listingRoot?.style.setProperty("--listing-sticky-stack", `${stack}px`);
    return stack;
  }
  const navEl = document.getElementById(NAVBAR_ID);
  const navH = isNative ? 0 : (navEl?.getBoundingClientRect().height ?? 0);
  if (!isNative && navH > 0) {
    document.documentElement.style.setProperty("--public-nav-height", `${navH}px`);
  }
  const safeTop =
    typeof window !== "undefined"
      ? Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--native-safe-top"),
        ) || 0
      : 0;
  const insetTop = isNative ? safeTop : 0;
  const stack = navH + insetTop + subnavEl.offsetHeight + 12;
  document.documentElement.style.setProperty("--listing-sticky-stack", `${stack}px`);
  const listingRoot = getListingSectionsRoot(subnavEl);
  listingRoot?.style.setProperty("--listing-sticky-stack", `${stack}px`);
  return stack;
}

function scrollToSection(
  id: string,
  mode: ListingSubnavMode,
  subnavEl: HTMLElement | null,
  pinned = false,
) {
  const el = getSectionElement(id, mode, subnavEl);
  if (!el) return;

  if (mode === "portal") {
    const root = getPortalScrollRoot(subnavEl);
    if (!root || !subnavEl) return;
    syncPortalDetailDestinationOffset(subnavEl);
    syncListingScrollStack(mode, subnavEl, pinned);
    const chromeH = readPortalStickyTopInset(subnavEl);
    const destOffset =
      Number.parseFloat(
        getComputedStyle(root).getPropertyValue("--portal-detail-destination-offset"),
      ) || 0;
    const subnavInPropertyChrome = Boolean(
      subnavEl.closest("[data-portal-property-detail-chrome]"),
    );
    const subnavH = subnavInPropertyChrome ? 0 : subnavEl.getBoundingClientRect().height;
    const y = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top: Math.max(0, y - chromeH - destOffset - subnavH - 10), behavior: "smooth" });
    return;
  }

  if (mode === "modal") {
    const root = getScrollRootFromSubnav(subnavEl);
    if (!root || !subnavEl) return;
    syncListingScrollStack(mode, subnavEl, pinned);
    // Below the desktop breakpoint the preview panel is not its own scroller
    // (the page/portal scroller moves instead) — defer to scrollIntoView there.
    if (root.scrollHeight <= root.clientHeight + 1) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const subnavH = pinned ? 0 : subnavEl.getBoundingClientRect().height;
    const y = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top: Math.max(0, y - subnavH - 10), behavior: "smooth" });
    return;
  }

  syncListingScrollStack(mode, subnavEl, pinned);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Sticky section tabs: full marketing pages use the public navbar offset; preview modal pins to top of its scroller. */
export function ListingStickySubnav({
  mode = "page",
  pinned = false,
  className = "",
  appearance = "marketing",
  align = "start",
}: {
  mode?: ListingSubnavMode;
  /** When true (preview shell), subnav is fixed above the scroller — not sticky over content. */
  pinned?: boolean;
  className?: string;
  /** Portal manager preview uses the same segmented tab chrome as property detail tabs. */
  appearance?: "marketing" | "portal";
  /** Pin listing section tabs to the trailing edge of the property detail chrome. */
  align?: "start" | "center" | "end";
}) {
  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  // While a click-initiated smooth scroll is in flight, the spy would flap
  // through intermediate sections — pin the clicked tab until it settles.
  const clickLockRef = useRef<{ id: string; until: number } | null>(null);
  const [pageScrolled, setPageScrolled] = useState(false);
  const [activeId, setActiveId] = useState<string>(nav[0].id);
  const [fadeEnd, setFadeEnd] = useState(false);

  const syncEdgeFade = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setFadeEnd(list.scrollLeft < list.scrollWidth - list.clientWidth - 2);
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    syncEdgeFade();
    list.addEventListener("scroll", syncEdgeFade, { passive: true });
    window.addEventListener("resize", syncEdgeFade, { passive: true });
    const ro = new ResizeObserver(syncEdgeFade);
    ro.observe(list);
    return () => {
      list.removeEventListener("scroll", syncEdgeFade);
      window.removeEventListener("resize", syncEdgeFade);
      ro.disconnect();
    };
  }, [syncEdgeFade]);

  const publishStackAndSpy = useCallback(() => {
    const subEl = rootRef.current;
    if (!subEl) return;

    if (mode === "modal") {
      const scrollRoot = getScrollRootFromSubnav(subEl);
      syncListingScrollStack(mode, subEl, pinned);
      setPageScrolled(pinned ? false : scrollRoot ? scrollRoot.scrollTop > 8 : false);
    } else if (mode === "portal") {
      const scrollRoot = getPortalScrollRoot(subEl);
      syncListingScrollStack(mode, subEl, pinned);
      setPageScrolled(scrollRoot ? scrollRoot.scrollTop > 8 : false);
    } else {
      syncListingScrollStack(mode, subEl);
      setPageScrolled(window.scrollY > 20);
    }

    // Slightly below where a clicked section lands (subnav + 10/12px offset),
    // so the spy agrees with the tab that was just clicked.
    const scrollRoot =
      mode === "modal" ? getScrollRootFromSubnav(subEl) : mode === "portal" ? getPortalScrollRoot(subEl) : null;
    const line =
      mode === "modal" && pinned && scrollRoot
        ? scrollRoot.getBoundingClientRect().top + 20
        : subEl.getBoundingClientRect().bottom + 16;
    let next: (typeof nav)[number]["id"] = nav[0].id;
    for (const item of nav) {
      const sec = getSectionElement(item.id, mode, subEl);
      if (sec && sec.getBoundingClientRect().top <= line) {
        next = item.id;
      }
    }
    const lock = clickLockRef.current;
    if (lock) {
      if (next === lock.id || Date.now() > lock.until) {
        clickLockRef.current = null;
      } else {
        next = lock.id as (typeof nav)[number]["id"];
      }
    }
    setActiveId(next);
  }, [mode, pinned]);

  useLayoutEffect(() => {
    const subEl = rootRef.current;
    if (!subEl) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const attachPageListeners = (navEl: HTMLElement) => {
      const ro = new ResizeObserver(() => {
        publishStackAndSpy();
      });
      ro.observe(navEl);
      ro.observe(subEl);

      const onScroll = () => publishStackAndSpy();
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", publishStackAndSpy, { passive: true });
      queueMicrotask(() => publishStackAndSpy());

      return () => {
        ro.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", publishStackAndSpy);
        document.documentElement.style.removeProperty("--listing-sticky-stack");
        document.documentElement.style.removeProperty("--public-nav-height");
        getListingSectionsRoot(subEl)?.style.removeProperty("--listing-sticky-stack");
      };
    };

    const attachModalListeners = () => {
      const scrollRoot = getScrollRootFromSubnav(subEl);
      const ro = new ResizeObserver(() => {
        publishStackAndSpy();
      });
      ro.observe(subEl);

      const onScroll = () => publishStackAndSpy();
      // The preview panel scrolls itself on desktop, but below the desktop
      // breakpoint the page/portal scroller moves instead — capture scrolls
      // from any container so the spy works in both layouts.
      document.addEventListener("scroll", onScroll, { capture: true, passive: true });
      window.addEventListener("resize", publishStackAndSpy, { passive: true });
      queueMicrotask(() => publishStackAndSpy());

      return () => {
        ro.disconnect();
        document.removeEventListener("scroll", onScroll, { capture: true });
        window.removeEventListener("resize", publishStackAndSpy);
        scrollRoot?.style.removeProperty("--listing-sticky-stack");
      };
    };

    const attachPortalListeners = () => {
      const scrollRoot = getPortalScrollRoot(subEl);
      const mobileChrome = scrollRoot?.querySelector<HTMLElement>(".portal-mobile-nav-bar") ?? null;
      const destinationNav =
        scrollRoot?.querySelector<HTMLElement>("[data-portal-detail-destination-nav]") ?? null;
      const propertyChrome =
        scrollRoot?.querySelector<HTMLElement>("[data-portal-property-detail-chrome]") ?? null;
      const ro = new ResizeObserver(() => {
        publishStackAndSpy();
      });
      ro.observe(subEl);
      if (mobileChrome) ro.observe(mobileChrome);
      if (destinationNav) ro.observe(destinationNav);
      if (propertyChrome) ro.observe(propertyChrome);

      const onScroll = () => publishStackAndSpy();
      scrollRoot?.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", publishStackAndSpy, { passive: true });
      queueMicrotask(() => {
        syncPortalDetailDestinationOffset(subEl);
        publishStackAndSpy();
      });

      return () => {
        ro.disconnect();
        scrollRoot?.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", publishStackAndSpy);
        scrollRoot?.style.removeProperty("--portal-mobile-top-chrome");
        scrollRoot?.style.removeProperty("--portal-detail-destination-offset");
        getListingSectionsRoot(subEl)?.style.removeProperty("--listing-sticky-stack");
      };
    };

    const tryAttach = () => {
      if (cancelled) return;
      if (mode === "portal") {
        cleanup = attachPortalListeners();
        return;
      }
      if (mode === "modal") {
        cleanup = attachModalListeners();
        return;
      }
      const navEl = document.getElementById(NAVBAR_ID);
      if (!navEl) {
        cleanup = attachPageListeners(document.body);
        return;
      }
      cleanup = attachPageListeners(navEl);
    };

    tryAttach();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [mode, pinned, publishStackAndSpy]);

  useEffect(() => {
    const node = tabRefs.current.get(activeId);
    const list = listRef.current;
    if (!node || !list || list.scrollWidth <= list.clientWidth + 1) return;
    // Center the active tab by scrolling only the strip — scrollIntoView would
    // also scroll ancestor containers and cancel an in-flight section scroll.
    const nodeRect = node.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const left = list.scrollLeft + (nodeRect.left - listRect.left) - (list.clientWidth - nodeRect.width) / 2;
    list.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [activeId]);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash || !nav.some((n) => n.id === hash)) return;
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        clickLockRef.current = { id: hash, until: Date.now() + 1500 };
        scrollToSection(hash, mode, rootRef.current, pinned);
        setActiveId(hash);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [mode, pinned]);

  const portalTabs = appearance === "portal";
  /** Property listing preview (manager tab, modal shell): fit all section tabs without horizontal clip. */
  const compactEqualTabs = portalTabs || (mode === "modal" && pinned);
  const alignEnd = align === "end";
  const alignCenter = align === "center";

  const portalSticky = mode === "portal" && !pinned;

  return (
    <nav
      ref={rootRef}
      data-listing-subnav
      data-listing-subnav-pinned={pinned ? "" : undefined}
      data-listing-subnav-portal={portalSticky ? "" : undefined}
      data-listing-subnav-align={alignCenter ? "center" : alignEnd ? "end" : undefined}
      className={`z-[45] min-w-0 w-full max-w-full overflow-hidden py-2 backdrop-blur-md transition-[background-color,border-color,box-shadow] duration-300 ease-out sm:py-2.5 [html[data-native]_&]:border-x-0 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2 ${
        portalTabs
          ? alignEnd || alignCenter
            ? `border-0 bg-transparent ${pinned ? "" : "sticky bg-background shadow-sm [top:var(--portal-mobile-top-chrome,0px)]"}`
            : `border-b border-border ${portalSticky ? "sticky bg-background shadow-sm [top:var(--portal-mobile-top-chrome,0px)]" : "bg-background"}`
          : compactEqualTabs
            ? `border-b border-border bg-accent/30 ${className}`
            : `border-b border-border ${pinned ? "relative top-0 bg-background" : "sticky -mx-4 shadow-sm sm:mx-0 sm:rounded-2xl [html[data-native]_&]:-mx-0 [html[data-native]_&]:rounded-none [html[data-native]_&]:pt-2"} ${className} ${
                pinned
                  ? "bg-background"
                  : pageScrolled
                    ? "bg-background/95 shadow-[0_1px_0_color-mix(in_srgb,var(--border)_70%,transparent)_inset,0_12px_40px_-20px_rgba(15,23,42,0.18)]"
                    : "bg-background/90"
              }`
      } ${portalTabs ? className : compactEqualTabs ? "" : ""}`}
      style={
        pinned
          ? { top: 0 }
          : mode === "modal"
            ? { top: 0 }
            : undefined
      }
      aria-label="Listing sections"
    >
      <ul
        ref={listRef}
        className={
          compactEqualTabs
            ? alignEnd
              ? "flex w-auto min-w-0 max-w-full flex-nowrap items-center justify-end gap-0.5 px-0.5 py-0.5 text-[10px] font-semibold leading-tight"
              : alignCenter
                ? "mx-auto flex w-full min-w-0 max-w-full flex-nowrap items-center justify-center gap-0.5 px-0.5 py-0.5 text-[10px] font-semibold leading-tight"
                : "grid w-full min-w-0 auto-cols-fr grid-flow-col gap-0.5 px-1 py-1 text-xs font-semibold leading-tight sm:text-[13px]"
            : `flex flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain px-2 py-0.5 text-[12px] font-semibold [-webkit-overflow-scrolling:touch] ${
                fadeEnd && mode !== "portal"
                  ? "[mask-image:linear-gradient(to_right,#000_calc(100%_-_1.75rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_1.75rem),transparent)] sm:[mask-image:none] sm:[-webkit-mask-image:none]"
                  : ""
              } justify-start sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0 sm:text-[13px]`
        }
      >
        {nav.map((item) => {
          const active = activeId === item.id;
          return (
            <li key={item.id} className={compactEqualTabs && !alignEnd && !alignCenter ? "min-w-0" : "shrink-0"}>
              <button
                ref={(el) => {
                  tabRefs.current.set(item.id, el);
                }}
                type="button"
                data-attr="listing-section-tab"
                aria-current={active ? "true" : undefined}
                className={`inline-flex w-full min-w-0 cursor-pointer items-center justify-center border-0 text-[inherit] transition-colors ${
                  compactEqualTabs
                    ? alignEnd || alignCenter
                      ? `min-h-8 rounded-md px-2 py-1 whitespace-nowrap w-auto ${
                          active
                            ? "bg-card text-foreground shadow-[var(--shadow-sm)] ring-1 ring-primary/25"
                            : "text-muted hover:bg-card/60 hover:text-foreground"
                        }`
                      : `min-h-9 rounded-lg px-0.5 py-1.5 sm:min-h-10 sm:px-1 ${
                          active
                            ? "bg-card text-foreground shadow-[var(--shadow-sm)] ring-1 ring-primary/25"
                            : "text-muted hover:bg-card/60 hover:text-foreground"
                        }`
                    : `min-h-[44px] rounded-xl px-3 py-2 sm:min-h-0 sm:py-1.5 ${
                        active
                          ? "rounded-full bg-primary text-primary-foreground shadow-sm"
                          : "rounded-full bg-transparent text-muted hover:bg-accent/40 hover:text-foreground"
                      }`
                }`}
                onClick={() => {
                  clickLockRef.current = { id: item.id, until: Date.now() + 1500 };
                  setActiveId(item.id);
                  scrollToSection(item.id, mode, rootRef.current, pinned);
                  if (mode === "page") {
                    try {
                      window.history.replaceState(null, "", `#${item.id}`);
                    } catch {
                      /* ignore */
                    }
                  }
                }}
              >
                {compactEqualTabs ? (
                  <span className="block w-full max-w-full truncate text-center">{item.shortLabel}</span>
                ) : (
                  <>
                    <span className="sm:hidden">{item.shortLabel}</span>
                    <span className="hidden sm:inline">{item.label}</span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
