"use client";

import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import { PortalNavCountBadge } from "@/components/portal/portal-nav-count-badge";
import { useNativeChrome } from "@/hooks/use-is-native-app";
import { isCrossPortalNavigation, portalNavClick } from "@/lib/portal-nav-client";
import { portalMobileLinkPrefetchEnabled } from "@/lib/portal-nav-prefetch";
import { groupNavItems } from "@/lib/portals/nav-groups";
import type { PortalKind } from "@/lib/portal-types";
import {
  PORTAL_NATIVE_BOTTOM_NAV_ICON_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS,
} from "@/lib/portal-layout-classes";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import { Drawer } from "vaul";

export type PortalMoreNavItem = {
  section: string;
  label: string;
  href: string;
  sectionTabId?: string;
  locked?: boolean;
  /**
   * A locked row that still navigates — the manager/pro free-tier case, whose
   * destination renders the `PortalTierPaywall` upgrade page. Locked rows are
   * inert by default (resident stage / resident free-tier locks have nothing to
   * buy); see the lock-kind note in `portal-sidebar.tsx`.
   */
  lockedNavigable?: boolean;
  count?: number;
};

function MoreGridIcon() {
  return (
    <svg className={PORTAL_NATIVE_BOTTOM_NAV_ICON_CLASS} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="5" r="1.75" />
      <circle cx="12" cy="5" r="1.75" />
      <circle cx="19" cy="5" r="1.75" />
      <circle cx="5" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
      <circle cx="5" cy="19" r="1.75" />
      <circle cx="12" cy="19" r="1.75" />
      <circle cx="19" cy="19" r="1.75" />
    </svg>
  );
}

type PortalNativeMoreSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PortalMoreNavItem[];
  /** Portal role — buckets the sheet into the same grouped sections as the web sidebar. */
  kind: PortalKind;
  activeSection: string;
  /** When set (e.g. payments incoming/outgoing), only this tab is active for the section. */
  activeSectionTabId?: string | null;
  showNavIcons: boolean;
};

function MoreNavRow({
  item,
  active,
  showNavIcons,
  onNavigate,
}: {
  item: PortalMoreNavItem;
  active: boolean;
  showNavIcons: boolean;
  onNavigate: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const nativeChrome = useNativeChrome();
  const inert = Boolean(item.locked) && !item.lockedNavigable;

  return (
    <Link
      href={inert ? "#" : item.href}
      prefetch={inert ? false : portalMobileLinkPrefetchEnabled()}
      onClick={(e) => {
        if (inert) {
          e.preventDefault();
          return;
        }
        portalNavClick(router, item.href, {
          preferFullNavigation: nativeChrome && isCrossPortalNavigation(pathname, item.href),
        })(e);
        onNavigate();
      }}
      className={`portal-pressable flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition active:opacity-90 ${
        active
          ? "bg-primary/10 text-primary"
          : inert
            ? "cursor-not-allowed text-muted/80"
            : item.locked
              ? "text-muted/80 hover:bg-accent/70"
              : "text-foreground hover:bg-accent/70"
      }`}
      aria-label={item.locked ? `${item.label} (locked)` : item.label}
      aria-disabled={inert ? true : undefined}
    >
      {showNavIcons ? (
        <span className={`shrink-0 ${item.locked ? "opacity-60" : ""}`} aria-hidden>
          <PortalNavIcon section={item.section} sectionTabId={item.sectionTabId} active={active} />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {!item.locked && (item.count ?? 0) > 0 ? <PortalNavCountBadge count={item.count ?? 0} /> : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted/60" aria-hidden />
    </Link>
  );
}

export function PortalNativeMoreSheet({
  open,
  onOpenChange,
  items,
  kind,
  activeSection,
  activeSectionTabId,
  showNavIcons,
}: PortalNativeMoreSheetProps) {
  const closeSheet = () => onOpenChange(false);

  const isMoreNavItemActive = (item: PortalMoreNavItem) => {
    if (activeSection !== item.section) return false;
    if (item.sectionTabId) return item.sectionTabId === activeSectionTabId;
    return true;
  };

  const navGroups = useMemo(() => {
    const grouped = groupNavItems(kind, items);
    const rendered = new Set(grouped.flatMap((g) => g.items.map((i) => i.section)));
    const trailing = items.filter((i) => !rendered.has(i.section) && i.section !== "profile");
    if (trailing.length) grouped.push({ id: "account-extra", label: null, items: trailing });
    return grouped;
  }, [kind, items]);

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} handleOnly>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[70] bg-black/50 motion-reduce:transition-none" />
        <Drawer.Content
          className="portal-native-more-sheet fixed inset-x-0 bottom-0 z-[71] flex !w-screen !max-w-none max-h-[min(85dvh,720px)] flex-col gap-0 rounded-none border-x-0 border-t border-border bg-background px-0 pb-[max(1rem,env(safe-area-inset-bottom,0px))] pt-0 outline-none motion-reduce:transition-none"
          data-slot="vaul-bottom-sheet"
        >
          <Drawer.Handle className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />
          <Drawer.Title className="sr-only">Portal sections</Drawer.Title>
          <div className="shrink-0 px-4 pb-1 pt-1 md:hidden" />
          <nav
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-1"
            aria-label="Portal sections"
          >
            {navGroups.map((group) => (
              <div key={group.id} className="flex flex-col gap-1 pt-1 first:pt-0">
                {group.label ? (
                  <p className="px-3 pb-1 pt-2.5 text-[10.5px] font-bold uppercase tracking-[0.09em] text-muted/70">
                    {group.label}
                  </p>
                ) : null}
                <ul className="space-y-1">
                  {group.items.map((item) => (
                    <li key={item.sectionTabId ? `${item.section}-${item.sectionTabId}` : item.section}>
                      <MoreNavRow
                        item={item}
                        active={isMoreNavItemActive(item)}
                        showNavIcons={showNavIcons}
                        onNavigate={closeSheet}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** Trailing tab in the fixed native bottom bar — opens the full section sheet. */
export function PortalNativeMoreNavButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-attr="bottom-nav-more"
      onClick={onClick}
      className={`${PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS} ${active ? "text-primary" : "text-muted"}`}
      aria-label="More portal sections"
    >
      {active ? (
        <span className="absolute inset-x-[18%] top-0 h-0.5 rounded-full bg-primary" aria-hidden />
      ) : null}
      <span
        className={`${PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS} transition-opacity duration-200 ${
          active ? "opacity-100" : "opacity-60"
        }`}
        aria-hidden
      >
        <MoreGridIcon />
      </span>
      <span className={`${PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS} ${active ? "text-primary" : "text-muted"}`}>
        More
      </span>
    </button>
  );
}
