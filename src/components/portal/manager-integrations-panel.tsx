"use client";

import { useEffect } from "react";

import { ManagerBookingChannelsPanel } from "@/components/portal/integrations-bookings-panel";
import { ManagerPostingPanel } from "@/components/portal/integrations-posting-panel";
import { ManagerSheetLinkPanel } from "@/components/portal/manager-sheet-link-panel";
import { ManagerMessageChannelsPanel } from "@/components/portal/integrations-messages-panel";
import { PortalSettingsSection } from "@/components/portal/portal-settings-ui";

export const INTEGRATIONS_TABS = [
  { id: "messages", label: "Messages" },
  { id: "bookings", label: "Bookings" },
  { id: "posting", label: "Posting" },
  { id: "google", label: "Google" },
] as const;

export type IntegrationsTabId = (typeof INTEGRATIONS_TABS)[number]["id"];

/** URL param that scrolls to one section (`?tab=spreadsheets&integration=posting`); the old per-tab links keep working. */
export const INTEGRATIONS_TAB_PARAM = "integration";

export function parseIntegrationsTab(raw: string | null | undefined): IntegrationsTabId | null {
  return INTEGRATIONS_TABS.find((tab) => tab.id === raw)?.id ?? null;
}

/**
 * Settings → Integrations: one page, four stacked sections (Messages, Bookings,
 * Posting, Google). Messages is the work number + work email connection rows;
 * they are edited only in Communication settings, which Manage opens. An old
 * `&integration=<id>` link (or `initialTab`) scrolls to that section.
 */
export function ManagerIntegrationsPanel({
  onOpenCommunication,
  initialTab,
}: {
  onOpenCommunication?: () => void;
  initialTab?: IntegrationsTabId;
}) {
  useEffect(() => {
    const target =
      initialTab ??
      (typeof window === "undefined" ? null : parseIntegrationsTab(new URLSearchParams(window.location.search).get(INTEGRATIONS_TAB_PARAM)));
    if (!target) return;
    document.querySelector(`[data-attr="settings-integrations-section-${target}"]`)?.scrollIntoView?.({ block: "start" });
  }, [initialTab]);

  return (
    <div className="space-y-4 lg:space-y-6" data-attr="settings-integrations">
      <div data-attr="settings-integrations-section-messages" className="scroll-mt-4">
        <PortalSettingsSection title="Messages">
          <ManagerMessageChannelsPanel onManage={onOpenCommunication} />
        </PortalSettingsSection>
      </div>
      <div data-attr="settings-integrations-section-bookings" className="scroll-mt-4">
        <PortalSettingsSection title="Bookings">
          <ManagerBookingChannelsPanel />
        </PortalSettingsSection>
      </div>
      <div data-attr="settings-integrations-section-posting" className="scroll-mt-4">
        <PortalSettingsSection title="Posting">
          <ManagerPostingPanel />
        </PortalSettingsSection>
      </div>
      <div data-attr="settings-integrations-section-google" className="scroll-mt-4">
        <PortalSettingsSection title="Google">
          <ManagerSheetLinkPanel />
        </PortalSettingsSection>
      </div>
    </div>
  );
}
