"use client";

import { useState } from "react";

import { ManagerBookingChannelsPanel } from "@/components/portal/integrations-bookings-panel";
import { ManagerPostingPanel } from "@/components/portal/integrations-posting-panel";
import { ManagerSheetLinkPanel } from "@/components/portal/manager-sheet-link-panel";
import { ManagerMessageChannelsPanel } from "@/components/portal/integrations-messages-panel";
import { cn } from "@/lib/utils";

export const INTEGRATIONS_TABS = [
  { id: "messages", label: "Messages" },
  { id: "bookings", label: "Bookings" },
  { id: "posting", label: "Posting" },
  { id: "google", label: "Google" },
] as const;

export type IntegrationsTabId = (typeof INTEGRATIONS_TABS)[number]["id"];

/** URL param that deep-links one sub-tab (`?tab=spreadsheets&integration=posting`). */
export const INTEGRATIONS_TAB_PARAM = "integration";

export function parseIntegrationsTab(raw: string | null | undefined): IntegrationsTabId {
  return INTEGRATIONS_TABS.find((tab) => tab.id === raw)?.id ?? "messages";
}

/**
 * Settings → Integrations: one page, sub-tabs on the left (a scrolling strip
 * on a phone). Messages is the work number + work email connection rows; they
 * are edited only in Communication settings, which Manage opens.
 */
export function ManagerIntegrationsPanel({
  onOpenCommunication,
  initialTab,
}: {
  onOpenCommunication?: () => void;
  initialTab?: IntegrationsTabId;
}) {
  const [tab, setTab] = useState<IntegrationsTabId>(() => {
    if (initialTab) return initialTab;
    if (typeof window === "undefined") return "messages";
    return parseIntegrationsTab(new URLSearchParams(window.location.search).get(INTEGRATIONS_TAB_PARAM));
  });

  const select = (next: IntegrationsTabId) => {
    setTab(next);
    try {
      const params = new URLSearchParams(window.location.search);
      params.set(INTEGRATIONS_TAB_PARAM, next);
      window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params}`);
    } catch {
      /* the address bar is a convenience; the tab is already switched */
    }
  };

  return (
    <div className="lg:flex lg:gap-8" data-attr="settings-integrations">
      <nav
        aria-label="Integrations"
        role="tablist"
        aria-orientation="vertical"
        className="-mx-1 mb-4 flex shrink-0 gap-1 overflow-x-auto px-1 lg:mx-0 lg:mb-0 lg:w-[160px] lg:flex-col lg:overflow-visible lg:px-0"
      >
        {INTEGRATIONS_TABS.map((item) => {
          const active = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              data-attr={`settings-integrations-tab-${item.id}`}
              onClick={() => select(item.id)}
              className={cn(
                "flex min-h-9 shrink-0 items-center rounded-lg px-3 py-2 text-left text-sm lg:w-full",
                active ? "bg-primary/10 text-primary" : "text-muted hover:bg-accent/40",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1 space-y-4" role="tabpanel" data-attr={`settings-integrations-pane-${tab}`}>
        {tab === "messages" ? <ManagerMessageChannelsPanel onManage={onOpenCommunication} /> : null}
        {tab === "bookings" ? <ManagerBookingChannelsPanel /> : null}
        {tab === "posting" ? <ManagerPostingPanel /> : null}
        {tab === "google" ? <ManagerSheetLinkPanel /> : null}
      </div>
    </div>
  );
}
