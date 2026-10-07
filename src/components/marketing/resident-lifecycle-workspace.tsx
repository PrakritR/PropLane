"use client";

/**
 * The window around the demo: Akhil's sidebar, workspace switcher, top bar and
 * profile, generalized so the manager, resident and vendor portals each get their
 * own tab list (from `DEMO_TABS`). Every sidebar item is a real button; the
 * content slot is whatever the engine renders for the active tab.
 */

import { type ReactNode } from "react";
import {
  Bell,
  Building2,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  FileText,
  Hammer,
  Home,
  MessageSquare,
  Sparkles,
  Star,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { AxisLogoMark } from "@/components/brand/axis-logo";
import type { DemoPortal, DemoTab } from "@/components/marketing/site/product-mock/demo-panels";
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

export function ResidentLifecycleWorkspace({
  portal,
  tabs,
  active,
  badges,
  onSelect,
  panel,
  children,
}: {
  portal: DemoPortal;
  tabs: DemoTab[];
  active: string;
  badges?: Record<string, number>;
  onSelect(tab: string): void;
  /** True when the content is a full-bleed portal screen, not Akhil's padded page. */
  panel: boolean;
  children: ReactNode;
}) {
  const meta = PORTAL_META[portal];
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
      <div className="rlp-main">
        <header className="rlp-topbar">
          {meta.assistant ? (
            <button type="button" className="rlp-assistant" onClick={() => {}}>
              <Sparkles aria-hidden /> Ask PropLane <kbd>⌘K</kbd>
            </button>
          ) : (
            <span className="rlp-assistant-spacer" />
          )}
          <button type="button" className="rlp-icon-button" aria-label="Notifications" title="Notifications" onClick={() => {}}>
            <Bell aria-hidden />
          </button>
          <button type="button" className="rlp-icon-button" aria-label="Profile" title="Profile" onClick={() => {}}>
            <span className="rlp-avatar">{meta.profile.initials}</span>
          </button>
        </header>
        <div id="rlp-workspace-panel" className={panel ? "rlp-canvas rlp-canvas-panel" : "rlp-canvas"}>
          {children}
        </div>
      </div>
    </section>
  );
}
