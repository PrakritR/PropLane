"use client";

/**
 * The window around the demo, drawn in the redesigned portal shell (approved plan
 * `dashboard-redesign-1007`, matching the real portal): a dark 40px top strip with
 * "Ask PropLane or search", an ink workspace rail (workspace tile, help, the account
 * avatar), a light 248px sidebar with collapsible groups, and the content slot. The AI
 * assistant is the only right panel: the strip's right icon docks it, as in the real
 * shell. Each portal gets its own tab list (`DEMO_TABS`, grouped like the real
 * `PORTAL_NAV_GROUPS`). Every sidebar item is a real button; the content slot is whatever
 * the engine renders for the active tab.
 *
 * The house mark stands for PropLane in the strip (`ProPlaneMarkIcon`, never a plane).
 */

import "./resident-lifecycle-shell.css";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  History,
  LogOut,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
  Sparkles,
  SquarePen,
  Users,
  X,
} from "lucide-react";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import { PortalNavCountBadge } from "@/components/portal/portal-nav-count-badge";
import type { DemoPortal, DemoTab } from "@/components/marketing/site/product-mock/demo-nav";
import { PROPERTY_ROWS } from "@/components/marketing/site/product-mock/fixtures";
import { portalSwitchTargets } from "@/lib/portal-switch-targets";
import { PORTAL_META } from "./resident-lifecycle-script";

/** One row of the assistant panel's "Needs attention": a title and the place it is about. */
export type AssistantNeed = { id: string; title: string; detail: string };

/** Alert (a red pill) for unread mail and overdue money, quiet numbers for ordinary pending work (`usePortalNavCounts`). */
const ALERT_COUNTS = new Set(["communication", "payments"]);

type TabGroup = { key: string; label?: string; tabs: DemoTab[] };

/** The real groups in the real order (`DEMO_TABS` is already `PORTAL_NAV_GROUPS` order). */
function groupTabs(tabs: DemoTab[]): TabGroup[] {
  const groups: TabGroup[] = [];
  for (const tab of tabs) {
    const key = tab.groupId ?? tab.group ?? "";
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = { key, label: tab.group, tabs: [] };
      groups.push(group);
    }
    group.tabs.push(tab);
  }
  return groups;
}

/**
 * The window's account menu, mirroring the real portal's rail avatar
 * (`portal-workspace-rail.tsx`): the avatar opens the account card, Settings, and
 * one "Switch to ... portal" row for each of the OTHER portals (the real list
 * comes from `portalSwitchTargets`, so the labels and order are the product's
 * own), then Sign out. Settings and Sign out do nothing: it is a sample.
 */
function AccountMenu({
  portal,
  onSwitchPortal,
  onOpenChange,
}: {
  portal: DemoPortal;
  onSwitchPortal?: (portal: DemoPortal) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const meta = PORTAL_META[portal];
  const [open, setOpenState] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const targets = onSwitchPortal ? portalSwitchTargets(portal, ["manager", "resident", "vendor"]) : [];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenState(false);
        onOpenChange?.(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenState(false);
        onOpenChange?.(false);
        rootRef.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div className="rlp-account" ref={rootRef}>
      <button
        type="button"
        className="rlp-account-trigger"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-attr="home-demo-account-menu"
        onClick={() => setOpen(!open)}
      >
        <span className="rlp-avatar">{meta.profile.initials}</span>
        <i className="pls-presence" aria-hidden />
      </button>
      {open ? (
        <div id={menuId} className="rlp-account-menu" role="menu" aria-label="Account">
          <div className="rlp-account-card">
            <strong>{meta.profile.name}</strong>
            <span>{meta.profile.email}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => setOpen(false)}>
            <Settings aria-hidden /> Settings
          </button>
          {targets.map((target) => (
            <button
              type="button"
              role="menuitem"
              key={target.role}
              data-attr={`home-demo-portal-${target.role}`}
              data-demo-portal={target.role}
              onClick={() => {
                setOpen(false);
                onSwitchPortal?.(target.role as DemoPortal);
              }}
            >
              <Users aria-hidden /> {target.label}
            </button>
          ))}
          <hr />
          <button type="button" role="menuitem" className="rlp-account-signout" onClick={() => setOpen(false)}>
            <LogOut aria-hidden /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The AI assistant, the shell's only right panel: PropLane, New, History and close in its header, then
 * the greeting, Needs attention (the same rows the Dashboard draws, counted from them) and the composer.
 */
function AssistantPanel({ needs, name, onClose }: { needs: AssistantNeed[]; name: string; onClose: () => void }) {
  return (
    <aside className="pls-assistant" aria-label="PropLane assistant">
      <header className="pls-assistant-head">
        <ProPlaneMarkIcon className="pls-assistant-mark" />
        <strong>PropLane</strong>
        <span className="pls-assistant-actions">
          <button type="button" aria-label="New chat" title="New chat">
            <SquarePen aria-hidden />
          </button>
          <button type="button" aria-label="History" title="History">
            <History aria-hidden />
          </button>
          <button type="button" aria-label="Close assistant" title="Close" onClick={onClose}>
            <X aria-hidden />
          </button>
        </span>
      </header>
      <div className="pls-assistant-body">
        <h3>Welcome back, {name}</h3>
        {needs.length ? (
          <section aria-label="Needs attention">
            <p className="pls-assistant-label">
              Needs attention <b>{needs.length}</b>
            </p>
            <ul>
              {needs.map((need) => (
                <li key={need.id}>
                  <strong>{need.title}</strong>
                  <span>{need.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <div className="pls-assistant-composer">
        <span>Ask PropLane</span>
        <ArrowUp aria-hidden />
      </div>
    </aside>
  );
}

export function ResidentLifecycleWorkspace({
  portal,
  tabs,
  active,
  badges,
  needs,
  onSelect,
  onSwitchPortal,
  onMenuOpenChange,
  panel,
  children,
}: {
  portal: DemoPortal;
  tabs: DemoTab[];
  active: string;
  badges?: Record<string, number>;
  /** The Dashboard's attention rows. When given, the strip's right icon docks the assistant panel. */
  needs?: AssistantNeed[];
  onSelect(tab: string, sub?: string): void;
  /** Switch the demo to another portal from the account menu; without it the menu lists no portals. */
  onSwitchPortal?: (portal: DemoPortal) => void;
  onMenuOpenChange?: (open: boolean) => void;
  /** True when the content is a full-bleed portal screen, not Akhil's padded page. */
  panel: boolean;
  children: ReactNode;
}) {
  const meta = PORTAL_META[portal];
  const [sideOpen, setSideOpen] = useState(true);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [subOpened, setSubOpened] = useState<Record<string, boolean>>({});
  const mainRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // The screen scrolls inside a fixed-size window (nothing is cut off, nothing grows it): while any
  // scroller in the screen has more below, the window's bottom edge fades out and a chevron says so;
  // once everything is in view both go away. (A list scrolls in its own `.portal-list-page-scroll`.)
  useEffect(() => {
    const canvas = canvasRef.current;
    const main = mainRef.current;
    if (!canvas || !main) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      let more = false;
      for (const el of [canvas, ...Array.from(canvas.querySelectorAll<HTMLElement>("*"))]) {
        if (el.scrollHeight - el.clientHeight < 6 || !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 6) {
          more = true;
          break;
        }
      }
      main.dataset.scroll = more ? "more" : "end";
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // `scroll` does not bubble: capture it to hear every scroller inside the screen.
    canvas.addEventListener("scroll", schedule, { passive: true, capture: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(canvas);
    const mutations = new MutationObserver(schedule);
    mutations.observe(canvas, { childList: true, subtree: true });
    return () => {
      canvas.removeEventListener("scroll", schedule, { capture: true });
      resize.disconnect();
      mutations.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Only the manager portal is a workspace portal (a workspace switcher); the resident and vendor sidebars say "PropLane".
  const isWorkspace = portal === "manager";
  const groups = groupTabs(tabs);
  const subline = portal === "manager" ? `${meta.product} · ${PROPERTY_ROWS.length} houses` : meta.product;
  const workspaceInitials = meta.workspace
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <section
      id="resident-lifecycle-workspace"
      className="rlp-workspace pls"
      data-side={sideOpen ? "open" : "closed"}
      data-assistant={needs && assistantOpen ? "open" : "closed"}
      aria-label={`Illustrative PropLane ${portal} workspace`}
    >
      <header className="rlp-topbar pls-strip">
        <div className="pls-strip-left">
          <button
            type="button"
            className="pls-strip-icon"
            aria-label="Toggle sidebar"
            aria-pressed={sideOpen}
            onClick={() => setSideOpen((open) => !open)}
          >
            <PanelLeft aria-hidden />
          </button>
          <span className="pls-strip-brand">
            <ProPlaneMarkIcon className="pls-strip-mark" />
            <strong>PropLane</strong>
          </span>
        </div>
        <button type="button" className="rlp-assistant pls-search" onClick={() => needs && setAssistantOpen(true)}>
          <Sparkles aria-hidden />
          <span>Ask PropLane or search {isWorkspace ? meta.workspace : meta.label}</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="pls-strip-right">
          {needs ? (
            <button
              type="button"
              className="pls-strip-icon"
              aria-label="Toggle assistant panel"
              aria-pressed={assistantOpen}
              onClick={() => setAssistantOpen((open) => !open)}
            >
              <PanelRight aria-hidden />
            </button>
          ) : null}
        </div>
      </header>
      <div className="pls-rail">
        <span className="pls-tile pls-tile-active" title={isWorkspace ? meta.workspace : "PropLane"}>
          {isWorkspace ? workspaceInitials : <ProPlaneMarkIcon className="pls-tile-mark" />}
        </span>
        {isWorkspace ? (
          <span className="pls-tile pls-tile-add" aria-hidden>
            <Plus />
          </span>
        ) : null}
        <span className="pls-rail-gap" />
        <span className="pls-rail-help" aria-hidden>
          <CircleHelp />
        </span>
        <AccountMenu portal={portal} onSwitchPortal={onSwitchPortal} onOpenChange={onMenuOpenChange} />
      </div>
      <aside className="rlp-sidebar pls-side" aria-label={`${meta.label} sidebar`}>
        <div className="pls-side-head">
          {isWorkspace ? (
            <button type="button" className="rlp-workspace-name pls-workspace-name" onClick={() => {}}>
              <strong>{meta.workspace}</strong> <ChevronDown aria-hidden />
            </button>
          ) : (
            <p className="rlp-workspace-name pls-workspace-name pls-brand-name">
              <strong>PropLane</strong>
            </p>
          )}
          <span className="pls-side-compose" aria-hidden>
            <SquarePen />
          </span>
          <p className="pls-side-sub">
            <i /> {subline}
          </p>
        </div>
        <nav className="rlp-nav pls-nav" aria-label={`${meta.label} navigation`}>
          {groups.map((group) => {
            const isCollapsed = Boolean(group.label && collapsed[group.key]);
            return (
              <div key={group.key || "home"} className="rlp-nav-group pls-group" data-collapsed={isCollapsed ? "true" : undefined}>
                {group.label ? (
                  <p className="pls-group-label">
                    <button
                      type="button"
                      aria-label={`${group.label} group`}
                      aria-expanded={!isCollapsed}
                      onClick={() => setCollapsed((state) => ({ ...state, [group.key]: !state[group.key] }))}
                    >
                      <ChevronDown aria-hidden />
                      {group.label}
                    </button>
                  </p>
                ) : null}
                {isCollapsed
                  ? null
                  : group.tabs.map((tab) => {
                      const badge = badges?.[tab.id];
                      const alert = ALERT_COUNTS.has(tab.id) && Boolean(badge);
                      const isActive = active === tab.id;
                      const subOpen = Boolean(tab.subItems?.length) && (subOpened[tab.id] ?? isActive);
                      return (
                        <div key={tab.id} className="pls-item-wrap">
                          <button
                            type="button"
                            className="rlp-nav-item pls-item"
                            aria-label={tab.label}
                            aria-current={isActive ? "page" : undefined}
                            aria-expanded={tab.subItems?.length ? subOpen : undefined}
                            data-demo-tab={tab.id}
                            data-demo-target={`nav-${tab.id}`}
                            data-unread={alert ? "true" : undefined}
                            onClick={() => {
                              if (tab.subItems?.length) setSubOpened((state) => ({ ...state, [tab.id]: !subOpen }));
                              onSelect(tab.id);
                            }}
                          >
                            <PortalNavIcon section={tab.id} active={isActive} className="pls-item-icon" />
                            <span>{tab.label}</span>
                            {badge ? <PortalNavCountBadge count={badge} tone={alert ? "alert" : "muted"} /> : null}
                            {tab.subItems?.length ? (
                              subOpen ? <ChevronDown className="pls-item-chevron" aria-hidden /> : <ChevronRight className="pls-item-chevron" aria-hidden />
                            ) : null}
                          </button>
                          {subOpen ? (
                            <div className="pls-subnav">
                              {tab.subItems!.map((sub) => (
                                <button type="button" key={sub.id} className="pls-subitem" onClick={() => onSelect(tab.id, sub.id)}>
                                  <PortalNavIcon section={tab.id} sectionTabId={sub.id} className="pls-subitem-icon" />
                                  <span>{sub.label}</span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="rlp-main pls-main" ref={mainRef}>
        <div id="rlp-workspace-panel" ref={canvasRef} className={panel ? "rlp-canvas rlp-canvas-panel" : "rlp-canvas"}>
          {children}
        </div>
      </div>
      {needs && assistantOpen ? <AssistantPanel needs={needs} name={meta.profile.name} onClose={() => setAssistantOpen(false)} /> : null}
    </section>
  );
}
