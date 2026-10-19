"use client";

import {
  Building2,
  HelpCircle,
  LayoutDashboard,
  Landmark,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AxisLogoGlyph } from "@/components/brand/axis-logo";
import { OwnerSearchDialog, ownerSearchTargets } from "@/components/owner/owner-search-dialog";
import { OwnerSectionTabs } from "@/components/owner/owner-section-tabs";
import { OwnerWorkspaceProvider, useOwnerWorkspace } from "@/components/owner/owner-workspace";
import { OwnerWorkspaceSwitcher, ownerHousesLine } from "@/components/owner/owner-workspace-switcher";
import { PortalAccountMenu, accountInitials } from "@/components/portal/portal-account-menu";
import { PortalHelpPanel } from "@/components/portal/portal-help-panel";
import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
import { workspaceTileLabels } from "@/components/portal/workspace-switcher";
import { usePortalSession } from "@/hooks/use-portal-session";
import {
  PORTAL_MAIN_CONTENT_CLASS,
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MAIN_CONTENT_INNER_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ICON_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS,
  PORTAL_SHELL_ROOT_CLASS,
} from "@/lib/portal-layout-classes";
import {
  getPortalSidebarCollapsed,
  subscribePortalSidebarCollapsed,
  syncPortalSidebarCollapsedAttribute,
  togglePortalSidebarCollapsed,
} from "@/lib/portal-sidebar-collapse-store";
import {
  OWNER_BASE_PATH,
  ownerNavItems,
  ownerPrimaryNavItems,
  ownerSectionForPath,
  type OwnerSectionId,
} from "@/lib/property-owner/sections";
import { cn } from "@/lib/utils";

/** Real glyphs for every row, the same family the other portals draw (never an empty circle). */
const ICONS: Record<OwnerSectionId, LucideIcon> = {
  overview: LayoutDashboard,
  properties: Building2,
  money: Landmark,
  messages: MessageSquare,
  settings: Settings,
};

const TILE =
  "relative grid size-9 shrink-0 place-items-center rounded-[9px] text-[13px] font-bold outline-none transition-transform duration-100 focus-visible:ring-2 focus-visible:ring-white/70";

/** Same row treatment as the sidebar of every other portal. */
function navLinkClass(active: boolean) {
  return cn(
    "group relative flex h-8 items-center justify-between gap-2 rounded-[7px] px-2 text-[15px] leading-5 tracking-[-0.003em] transition-colors duration-100",
    active
      ? "bg-[var(--portal-sidebar-active-bg)] font-semibold text-[var(--portal-sidebar-active-fg)]"
      : "font-normal text-foreground/80 hover:bg-[rgba(17,24,39,0.045)]",
  );
}

function OwnerTopStrip({ initialCollapsed, onSearch }: { initialCollapsed: boolean; onSearch: () => void }) {
  const collapsed = useSyncExternalStore(
    subscribePortalSidebarCollapsed,
    () => getPortalSidebarCollapsed(initialCollapsed),
    () => initialCollapsed,
  );
  return (
    <header
      className="hidden h-10 shrink-0 items-center gap-2 bg-[var(--portal-strip-bg)] px-2.5 text-[var(--portal-strip-fg)] lg:flex"
      data-slot="portal-top-strip"
    >
      <button
        type="button"
        onClick={() => togglePortalSidebarCollapsed(initialCollapsed)}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        data-attr="owner-sidebar-toggle"
        className="grid size-7 min-h-0 shrink-0 place-items-center rounded-[6px] text-inherit opacity-85 outline-none transition hover:bg-white/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/50"
      >
        <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onSearch}
        data-attr="owner-search-open"
        aria-label="Search"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        className="mx-auto my-auto flex h-7 min-h-0 min-w-0 flex-[0_1_560px] cursor-pointer items-center gap-2 rounded-[7px] border border-white/[0.12] bg-white/10 px-2.5 text-[13px] text-inherit outline-none transition hover:bg-white/[0.16] focus-visible:ring-2 focus-visible:ring-white/50"
      >
        <Search className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">Search</span>
        <kbd className="ml-auto shrink-0 rounded-[4px] border border-white/20 px-[5px] text-[11px] font-normal leading-4 opacity-80">⌘K</kbd>
      </button>
      <span className="size-7 shrink-0" aria-hidden />
    </header>
  );
}

function OwnerRail({ name, email }: { name: string | null; email: string | null }) {
  const ctx = useOwnerWorkspace();
  const session = usePortalSession();
  const [helpOpen, setHelpOpen] = useState(false);
  const workspaces = ctx?.workspaces ?? [];
  const labels = workspaceTileLabels(workspaces.map((w) => w.label));
  return (
    <>
      <nav
        aria-label="Workspaces"
        data-slot="portal-workspace-rail"
        className="hidden w-[60px] shrink-0 flex-col items-center gap-2.5 bg-[var(--portal-strip-bg)] py-2.5 text-[var(--portal-strip-fg)] lg:flex"
      >
        {ctx?.loading && workspaces.length === 0 ? (
          <span className={cn(TILE, "animate-pulse bg-[color-mix(in_srgb,var(--portal-strip-fg)_18%,var(--portal-strip-bg))] motion-reduce:animate-none")} aria-hidden />
        ) : workspaces.length === 0 ? (
          <span className={cn(TILE, "bg-[var(--portal-canvas)] shadow-[0_0_0_2px_var(--portal-strip-bg),0_0_0_4px_var(--portal-canvas)]")} title="PropLane" data-attr="owner-rail-brand">
            <AxisLogoGlyph size="micro" />
          </span>
        ) : (
          workspaces.map((workspace, index) => {
            const active = workspace.id === ctx?.activeId;
            return (
              <button
                key={workspace.id}
                type="button"
                title={workspace.label}
                aria-label={`Switch workspace: ${workspace.label}`}
                aria-current={active ? "true" : undefined}
                data-attr="owner-rail-workspace"
                onClick={() => (active ? undefined : ctx?.select(workspace.id))}
                className={cn(
                  TILE,
                  "hover:-translate-y-px",
                  active ? "bg-white text-[var(--portal-strip-bg)] shadow-[0_0_0_2px_var(--portal-strip-bg),0_0_0_4px_var(--portal-canvas)]" : "bg-[color-mix(in_srgb,var(--portal-strip-fg)_18%,var(--portal-strip-bg))] text-white",
                )}
              >
                {labels[index]}
              </button>
            );
          })
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          title="Help and feedback"
          aria-label="Help and feedback"
          data-attr="owner-help"
          className="grid size-9 place-items-center rounded-[9px] text-inherit outline-none transition hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <HelpCircle className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
        <PortalAccountMenu kind="manager" basePath={OWNER_BASE_PATH} name={name} email={email} onOpenHelp={() => setHelpOpen(true)} />
      </nav>
      <PortalHelpPanel
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        reporterRole="manager"
        reporterUserId={session.userId}
        reporterEmail={session.email ?? ""}
        reporterName={session.email ?? ""}
      />
    </>
  );
}

function OwnerSidebar({ messagesOn, initialCollapsed, active }: { messagesOn: boolean; initialCollapsed: boolean; active: OwnerSectionId | null }) {
  const ctx = useOwnerWorkspace();
  const collapsed = useSyncExternalStore(
    subscribePortalSidebarCollapsed,
    () => getPortalSidebarCollapsed(initialCollapsed),
    () => initialCollapsed,
  );
  useEffect(() => {
    syncPortalSidebarCollapsedAttribute(collapsed);
  }, [collapsed]);
  const items = ownerNavItems(messagesOn).filter((item) => item.id !== "settings");
  const settings = ownerNavItems(messagesOn).find((item) => item.id === "settings");
  const renderRow = (item: { id: OwnerSectionId; label: string; href: string }) => {
    const Icon = ICONS[item.id];
    const isActive = active === item.id;
    return (
      <Link
        key={item.id}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        data-attr={`owner-nav-${item.id}`}
        className={navLinkClass(isActive)}
      >
        <span className="flex min-w-0 flex-1 items-center gap-[9px]">
          <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 truncate">{item.label}</span>
        </span>
      </Link>
    );
  };
  return (
    <aside
      aria-hidden={collapsed || undefined}
      className={cn(
        "relative z-40 hidden h-full min-h-0 w-[248px] shrink-0 self-stretch flex-col overflow-hidden border-r border-border bg-[var(--portal-sidebar-bg)]",
        collapsed ? "lg:hidden" : "lg:flex",
      )}
      data-slot="portal-sidebar"
      data-attr="owner-sidebar"
    >
      <div className="flex shrink-0 items-start gap-1.5 pb-2 pl-3.5 pr-2.5 pt-3">
        <div className="min-w-0 flex-1">
          <OwnerWorkspaceSwitcher variant="sidebar" />
          <p className="mt-0.5 flex items-center gap-[5px] text-[12px] text-muted">
            <b aria-hidden className="inline-block size-1.5 rounded-full bg-[var(--green)]" />
            <span className="min-w-0 truncate">{ctx?.active ? `Owner · ${ownerHousesLine(ctx.active.houses)}` : "Owner"}</span>
          </p>
        </div>
      </div>
      <nav aria-label="Owner" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overscroll-contain px-2 pb-3 pt-1 [scrollbar-width:thin]">
        {items.map(renderRow)}
      </nav>
      {settings ? <div className="shrink-0 border-t border-border px-2 py-2">{renderRow(settings)}</div> : null}
    </aside>
  );
}

function OwnerMobileBar({ name, email }: { name: string | null; email: string | null }) {
  const pathname = usePathname() ?? "";
  const section = ownerSectionForPath(pathname);
  const ctx = useOwnerWorkspace();
  const label = ownerNavItems(true).find((item) => item.id === section)?.label ?? "Overview";
  return (
    <div className="portal-mobile-nav-bar relative mb-0 flex h-14 min-h-14 w-full items-center justify-between gap-2 lg:hidden" data-attr="owner-mobile-bar">
      {section === "overview" || section === "properties" ? (
        <div className="min-w-0 flex-1">
          <OwnerWorkspaceSwitcher variant="mobile" />
        </div>
      ) : (
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-[-0.02em] text-foreground">
          {label}
          {ctx?.active && (ctx.workspaces.length ?? 0) > 1 ? <span className="sr-only"> in {ctx.active.label}</span> : null}
        </h1>
      )}
      <Link
        href={`${OWNER_BASE_PATH}/profile`}
        aria-label="Settings"
        data-attr="owner-mobile-avatar"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-[var(--portal-avatar-bg,var(--primary))] text-[13px] font-extrabold text-[var(--portal-avatar-fg)] outline-none transition focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {accountInitials(name, email)}
      </Link>
    </div>
  );
}

function OwnerBottomBar({ messagesOn, active }: { messagesOn: boolean; active: OwnerSectionId | null }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = ownerPrimaryNavItems(messagesOn);
  const moreItems = ownerNavItems(messagesOn).filter((item) => !primary.some((p) => p.id === item.id));
  return (
    <>
      <nav aria-label="Owner" className={PORTAL_NATIVE_BOTTOM_NAV_CLASS} data-attr="owner-bottom-nav">
        <div className="flex">
          {primary.map((item) => {
            const Icon = ICONS[item.id];
            const isActive = active === item.id;
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                data-attr={`owner-bottom-${item.id}`}
                className={cn(PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS, "flex-1", isActive ? "text-primary" : "text-muted")}
              >
                <span className={PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS}>
                  <Icon className={PORTAL_NATIVE_BOTTOM_NAV_ICON_CLASS} strokeWidth={isActive ? 2.1 : 1.75} aria-hidden />
                </span>
                <span className={PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS}>{item.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            data-attr="owner-bottom-more"
            onClick={() => setMoreOpen((open) => !open)}
            className={cn(PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS, "flex-1", active === "settings" ? "text-primary" : "text-muted")}
          >
            <span className={PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS}>
              <MoreHorizontal className={PORTAL_NATIVE_BOTTOM_NAV_ICON_CLASS} strokeWidth={1.75} aria-hidden />
            </span>
            <span className={PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS}>More</span>
          </button>
        </div>
      </nav>
      {moreOpen ? (
        <div className="fixed inset-x-0 bottom-[4.75rem] z-[60] mx-3 rounded-2xl border border-border bg-card p-2 shadow-lg lg:hidden" role="menu" data-attr="owner-more-sheet">
          {moreItems.map((item) => {
            const Icon = ICONS[item.id];
            return (
              <Link
                key={item.id}
                href={item.href}
                role="menuitem"
                onClick={() => setMoreOpen(false)}
                data-attr={`owner-more-${item.id}`}
                className="flex items-center gap-2.5 rounded-lg px-3 py-3 text-sm font-medium text-foreground"
              >
                <Icon className="size-4" strokeWidth={1.75} aria-hidden />
                {item.label}
              </Link>
            );
          })}
          <div className="px-3 py-3">
            <PortalSignOutButton className="text-sm font-semibold text-red-600" onRequestConfirm={() => setMoreOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ShellFrame({
  messagesOn,
  financesOn,
  name,
  email,
  initialSidebarCollapsed,
  children,
}: {
  messagesOn: boolean;
  financesOn: boolean;
  name: string | null;
  email: string | null;
  initialSidebarCollapsed: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const ctx = useOwnerWorkspace();
  const active = ownerSectionForPath(pathname);
  const [searchOpen, setSearchOpen] = useState(false);
  const targets = useMemo(() => ownerSearchTargets(messagesOn, financesOn), [messagesOn, financesOn]);

  // Cmd/Ctrl+K opens the search, unless a field or dialog already owns the key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') && !searchOpen) return;
      event.preventDefault();
      setSearchOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);

  return (
    <div className={PORTAL_SHELL_ROOT_CLASS} data-attr="owner-shell">
      <OwnerTopStrip initialCollapsed={initialSidebarCollapsed} onSearch={() => setSearchOpen(true)} />
      <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
        <OwnerRail name={name} email={email} />
        <OwnerSidebar messagesOn={messagesOn} initialCollapsed={initialSidebarCollapsed} active={active} />
        <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <main id={PORTAL_MAIN_CONTENT_ID} tabIndex={-1} className={cn(PORTAL_MAIN_CONTENT_CLASS, "pb-24 lg:pb-0")}>
            <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>
              <OwnerMobileBar name={name} email={email} />
              <OwnerSectionTabs financesOn={financesOn} />
              {/* A switch throws the page's own state away (house tab, month) so nothing from the other workspace lingers. */}
              <div key={ctx?.activeId ?? "none"}>{children}</div>
            </div>
          </main>
          <OwnerBottomBar messagesOn={messagesOn} active={active} />
        </div>
      </div>
      <OwnerSearchDialog open={searchOpen} onOpenChange={setSearchOpen} targets={targets} />
    </div>
  );
}

/**
 * The whole shell for an owner-only account, built from the same pieces as every other portal: the dark top strip with search,
 * the 60px workspace rail (one tile per workspace the person is an owner in, Help, the account menu), the light 248px sidebar
 * with the workspace heading and at most five rows, and on a phone the same header line, bottom bar and More sheet. It is not
 * the manager shell with items hidden: it carries no plan banner, no assistant and no manager nav to leak.
 */
export function OwnerPortalShell({
  messagesOn,
  financesOn = false,
  name = null,
  email = null,
  initialSidebarCollapsed = false,
  children,
}: {
  messagesOn: boolean;
  financesOn?: boolean;
  name?: string | null;
  email?: string | null;
  initialSidebarCollapsed?: boolean;
  children: ReactNode;
}) {
  return (
    <OwnerWorkspaceProvider>
      <ShellFrame messagesOn={messagesOn} financesOn={financesOn} name={name} email={email} initialSidebarCollapsed={initialSidebarCollapsed}>
        {children}
      </ShellFrame>
    </OwnerWorkspaceProvider>
  );
}
