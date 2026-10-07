"use client";

/**
 * The window around the demo: Akhil's sidebar, workspace switcher, top bar and
 * profile, generalized so the manager, resident and vendor portals each get their
 * own tab list (from `DEMO_TABS`). Every sidebar item is a real button; the
 * content slot is whatever the engine renders for the active tab.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Building2,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  FileText,
  Hammer,
  Home,
  LogOut,
  MessageSquare,
  Settings,
  Sparkles,
  Star,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { AxisLogoMark } from "@/components/brand/axis-logo";
import type { DemoPortal, DemoTab } from "@/components/marketing/site/product-mock/demo-panels";
import { portalSwitchTargets } from "@/lib/portal-switch-targets";
import { PORTAL_META } from "./resident-lifecycle-script";

const TAB_ICONS: Record<string, LucideIcon> = {
  dashboard: Home,
  home: Home,
  properties: Building2,
  tours: CalendarDays,
  calendar: CalendarDays,
  applications: ClipboardList,
  forms: ClipboardCheck,
  leases: FileText,
  lease: FileText,
  residents: Users,
  payments: CreditCard,
  services: Wrench,
  communication: MessageSquare,
  vendors: Hammer,
  reviews: Star,
};

function groupTabs(tabs: DemoTab[]): { label?: string; tabs: DemoTab[] }[] {
  const groups: { label?: string; tabs: DemoTab[] }[] = [];
  for (const tab of tabs) {
    const last = groups[groups.length - 1];
    if (last && last.label === tab.group) last.tabs.push(tab);
    else groups.push({ label: tab.group, tabs: [tab] });
  }
  return groups;
}

/**
 * The window's account menu, mirroring the real portal's top bar
 * (`portal-top-bar.tsx`): the avatar pill opens the account card, Settings, and
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
        <ChevronDown aria-hidden />
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

export function ResidentLifecycleWorkspace({
  portal,
  tabs,
  active,
  badges,
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
  onSelect(tab: string): void;
  /** Switch the demo to another portal from the account menu; without it the menu lists no portals. */
  onSwitchPortal?: (portal: DemoPortal) => void;
  onMenuOpenChange?: (open: boolean) => void;
  /** True when the content is a full-bleed portal screen, not Akhil's padded page. */
  panel: boolean;
  children: ReactNode;
}) {
  const meta = PORTAL_META[portal];
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

  return (
    <section
      id="resident-lifecycle-workspace"
      className="rlp-workspace"
      aria-label={`Illustrative PropLane ${portal} workspace`}
    >
      <aside className="rlp-sidebar" aria-label={`${meta.label} sidebar`}>
        <div className="rlp-brand">
          <AxisLogoMark size="compact" />
          <div>
            <strong>PropLane</strong>
            <span>
              <i /> {meta.product}
            </span>
          </div>
        </div>
        <button type="button" className="rlp-workspace-name" onClick={() => {}}>
          {meta.workspace} <ChevronDown aria-hidden />
        </button>
        <nav className="rlp-nav" aria-label={`${meta.label} navigation`}>
          {groupTabs(tabs).map((group, index) => (
            <div key={`${group.label ?? "tabs"}-${index}`} className="rlp-nav-group">
              {group.label ? <p>{group.label}</p> : null}
              {group.tabs.map((tab) => {
                const Icon = TAB_ICONS[tab.id] ?? FileText;
                const badge = badges?.[tab.id];
                return (
                  <button
                    type="button"
                    key={tab.id}
                    className="rlp-nav-item"
                    aria-label={tab.label}
                    aria-current={active === tab.id ? "page" : undefined}
                    data-demo-tab={tab.id}
                    data-demo-target={`nav-${tab.id}`}
                    onClick={() => onSelect(tab.id)}
                  >
                    <Icon aria-hidden />
                    <span>{tab.label}</span>
                    {badge ? <b>{badge}</b> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <button type="button" className="rlp-profile" onClick={() => {}}>
          <span>{meta.profile.initials}</span>
          <strong>{meta.profile.name}</strong>
          <ChevronDown aria-hidden />
        </button>
      </aside>
      <div className="rlp-main" ref={mainRef}>
        <header className="rlp-topbar">
          <button type="button" className="rlp-assistant" onClick={() => {}}>
            <Sparkles aria-hidden /> Ask PropLane <kbd>⌘K</kbd>
          </button>
          <AccountMenu portal={portal} onSwitchPortal={onSwitchPortal} onOpenChange={onMenuOpenChange} />
        </header>
        <div id="rlp-workspace-panel" ref={canvasRef} className={panel ? "rlp-canvas rlp-canvas-panel" : "rlp-canvas"}>
          {children}
        </div>
      </div>
    </section>
  );
}
