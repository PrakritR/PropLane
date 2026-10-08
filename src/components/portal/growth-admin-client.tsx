"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { GrowthQueueTab, GrowthNewPostModal } from "@/components/portal/growth-queue-tab";
import { GrowthCalendarTab } from "@/components/portal/growth-calendar-tab";
import { GrowthPostDetail } from "@/components/portal/growth-post-detail";
import { GrowthAccountsTab } from "@/components/portal/growth-accounts-tab";
import { GrowthAnalyticsTab } from "@/components/portal/growth-analytics-tab";

export const GROWTH_TABS = ["queue", "calendar", "accounts", "analytics"] as const;
export type GrowthTabId = (typeof GROWTH_TABS)[number];

const TAB_LABEL: Record<GrowthTabId, string> = {
  queue: "Queue",
  calendar: "Calendar",
  accounts: "Accounts",
  analytics: "Analytics",
};

/**
 * Growth: PropLane's own social content pipeline. `postId` set means the Post tab
 * (`/admin/growth/post/<id>`); otherwise `tab` picks one of the four list tabs.
 * Reel studio and Engage list are Phase 2/3 and have no tab yet.
 */
export function GrowthAdminClient({ tab = "queue", postId }: { tab?: GrowthTabId; postId?: string }) {
  const navigate = usePortalNavigate();
  const [newPostOpen, setNewPostOpen] = useState(false);

  const tabs = GROWTH_TABS.map((id) => ({
    id,
    label: TAB_LABEL[id],
    href: id === "queue" ? "/admin/growth" : `/admin/growth/${id}`,
    dataAttr: `admin-growth-tab-${id}`,
  }));
  const active = postId ? "" : tab;

  return (
    <ManagerPortalPageShell title="Growth" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      {/* Wrapped so the band keeps the column's padding: this page has no page-header, and the shell's -2rem
          bleed for a direct-child band is clipped by .portal-main-inner without one. */}
      <div className="mb-3" data-attr="admin-growth-band">
      <PortalListControlStack
        variant="command"
        stickyDestinations={false}
        destinations={tabs}
        activeDestinationId={active}
        destinationAriaLabel="Growth section"
        primary={
          <PortalPrimaryIconAction label="Add post" data-attr="admin-growth-new-post" onClick={() => setNewPostOpen(true)} />
        }
      />
      </div>
      {postId ? (
        <GrowthPostDetail postId={postId} />
      ) : tab === "queue" ? (
        <>
          <div className="mb-3 flex justify-end">
            <Button type="button" variant="outline" className="h-9 px-3 text-xs" data-attr="admin-growth-connect-account" onClick={() => navigate("/admin/growth/accounts")}>
              Connect account
            </Button>
          </div>
          <GrowthQueueTab />
        </>
      ) : tab === "calendar" ? (
        <GrowthCalendarTab />
      ) : tab === "accounts" ? (
        <GrowthAccountsTab />
      ) : (
        <GrowthAnalyticsTab />
      )}
      <GrowthNewPostModal open={newPostOpen} onClose={() => setNewPostOpen(false)} />
    </ManagerPortalPageShell>
  );
}
