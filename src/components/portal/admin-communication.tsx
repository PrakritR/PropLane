"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AdminInboxClient, type AdminInboxClientHandle, type AdminInboxTabCounts } from "@/components/portal/admin-inbox-client";
import { ManagerSmsPanel, type ManagerSmsPanelHandle } from "@/components/portal/pro-sms-panel";
import { PortalCommunicationShell } from "@/components/portal/portal-communication-shell";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";

export type AdminEmailTabId = "unopened" | "opened" | "schedule" | "sent" | "trash";

const ADMIN_COMM_BASE = "/admin/communication";

export function AdminCommunication({
  smsUiEnabled = false,
}: {
  /** @deprecated Folder tabs removed — kept so legacy routes still resolve. */
  inboxTabId?: AdminEmailTabId;
  /**
   * Server-resolved SMS Communication UI flag. When false (default) the "Text
   * messages" panel is hidden entirely — transport, webhooks, and both SMS
   * agents are unaffected.
   */
  smsUiEnabled?: boolean;
}) {
  const inboxRef = useRef<AdminInboxClientHandle>(null);
  const smsRef = useRef<ManagerSmsPanelHandle>(null);
  // Trashed/archived conversations and pending scheduled sends are each reachable
  // via a toggle, not a folder tab. Admin rows are a flat table with no chat pane
  // to host manager/resident-style inline scheduled cards, and a scheduled send
  // to someone the admin has never messaged has no conversation row to sit in —
  // so the schedule surface stays a view of its own. Without it, staff can create
  // scheduled sends they can never view or cancel.
  const [view, setView] = useState<"all" | "trash" | "schedule">("all");
  const [trashCount, setTrashCount] = useState(0);
  const [scheduleCount, setScheduleCount] = useState(0);
  const handleEmailTabCountsChange = useCallback((counts: AdminInboxTabCounts) => {
    setTrashCount(counts.trash);
    setScheduleCount(counts.schedule);
  }, []);

  const showArchived = view === "trash";
  const showSchedule = view === "schedule";

  const titleAside = (
    <>
      {showArchived && trashCount > 0 ? (
        <Button
          type="button"
          variant="outline"
          className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]`}
          onClick={() => inboxRef.current?.emptyTrash()}
        >
          Delete all trash
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
        data-attr="admin-inbox-scheduled-toggle"
        aria-pressed={showSchedule}
        onClick={() => setView((v) => (v === "schedule" ? "all" : "schedule"))}
      >
        {showSchedule ? "← Conversations" : `Scheduled${scheduleCount > 0 ? ` (${scheduleCount})` : ""}`}
      </Button>
      <Button
        type="button"
        variant="outline"
        className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
        data-attr="admin-inbox-archived-toggle"
        aria-pressed={showArchived}
        onClick={() => setView((v) => (v === "trash" ? "all" : "trash"))}
      >
        {showArchived ? "← Conversations" : `Archived${trashCount > 0 ? ` (${trashCount})` : ""}`}
      </Button>
      <Button
        type="button"
        variant="primary"
        className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
        onClick={() => inboxRef.current?.openCompose()}
      >
        New message
      </Button>
    </>
  );

  return (
    <PortalCommunicationShell title="Communication" titleAside={titleAside}>
      <div className="space-y-6">
        <AdminInboxClient
          ref={inboxRef}
          tabId={view}
          commBase={`${ADMIN_COMM_BASE}/inbox`}
          embeddedInCommunication
          externalTitleActions
          onTabCountsChange={handleEmailTabCountsChange}
        />
        {smsUiEnabled && view === "all" ? (
          <section className="rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">Text messages</h2>
              <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                SMS
              </span>
            </div>
            <ManagerSmsPanel
              ref={smsRef}
              endpoint="/api/admin/sms-conversations"
              allowInlineCompose
              allowDelete={false}
            />
          </section>
        ) : null}
      </div>
    </PortalCommunicationShell>
  );
}
