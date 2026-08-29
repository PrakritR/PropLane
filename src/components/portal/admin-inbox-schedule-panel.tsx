"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { MANAGER_TABLE_TH, PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import {
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TR_EXPANDABLE,
  PORTAL_TABLE_TD,
} from "@/components/portal/portal-data-table";
import { PortalInboxEmptyState } from "@/components/portal/portal-inbox-ui";
import { ScheduleInboxComposeForm } from "@/components/portal/schedule-inbox-compose-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  INBOX_SCHEDULE_HORIZON_OPTIONS,
  inboxScheduleHorizonDays,
  sendAtWithinScheduleHorizon,
  type InboxScheduleHorizonId,
} from "@/lib/inbox-schedule-horizon";
import { Select } from "@/components/ui/input";
import {
  isUpcomingScheduledInboxMessage,
  type ScheduledInboxMessageRecord,
} from "@/lib/scheduled-inbox-messages";

function formatSendDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function messagePreview(body: string, max = 120): string {
  const text = body.trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function statusClass(status: string): string {
  if (status === "sent") return "text-emerald-700";
  if (status === "cancelled") return "text-muted line-through";
  return "text-primary";
}

/** Admin counterpart of ManagerInboxSchedulePanel — same manual-message backend
 * and list chrome, no payment-automation rows (admins have no charges) and
 * "Schedule message" opens the admin compose modal (its recipient model is
 * platform-wide, not the manager's property-scoped address book). Messages and
 * reload are owned by the parent (which also needs the count for the tab pill)
 * so compose-modal sends and this panel's own edits stay on one source of truth. */
export function AdminInboxSchedulePanel({
  messages,
  loading,
  onReload,
  onScheduleNew,
}: {
  messages: ScheduledInboxMessageRecord[];
  loading: boolean;
  onReload: () => void;
  onScheduleNew: () => void;
}) {
  const { showToast } = useAppUi();
  const [horizonId, setHorizonId] = useState<InboxScheduleHorizonId>("14");
  const horizonDays = inboxScheduleHorizonDays(horizonId);

  const [editMessage, setEditMessage] = useState<ScheduledInboxMessageRecord | null>(null);

  const rows = useMemo(() => {
    return messages
      .filter((message) => isUpcomingScheduledInboxMessage(message.sendAt, message.status))
      .filter((message) => sendAtWithinScheduleHorizon(message.sendAt, horizonDays))
      .sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  }, [messages, horizonDays]);

  const scheduledCount = useMemo(() => rows.filter((row) => row.status === "scheduled").length, [rows]);

  const toggleCancelled = async (message: ScheduledInboxMessageRecord, cancelled: boolean) => {
    try {
      const res = await fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(message.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cancelled }),
      });
      if (!res.ok) throw new Error("Could not update.");
      showToast(cancelled ? "Send cancelled." : "Send restored.");
      onReload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not update.");
    }
  };

  const horizonLabel = INBOX_SCHEDULE_HORIZON_OPTIONS.find((opt) => opt.id === horizonId)?.label ?? "Show upcoming";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {scheduledCount} scheduled in view · {horizonLabel.toLowerCase()}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-xs font-medium text-muted">
            <span className="sr-only">Show messages scheduled within</span>
            <Select
             
              value={horizonId}
              onChange={(e) => setHorizonId(e.target.value as InboxScheduleHorizonId)}
            >
              {INBOX_SCHEDULE_HORIZON_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </label>
          <Button
            type="button"
            variant="primary"
            className={`rounded-full text-xs ${PORTAL_HEADER_ACTION_BTN}`}
            onClick={onScheduleNew}
            aria-haspopup="dialog"
            data-attr="admin-schedule-message"
          >
            Schedule message
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading schedule…</p>
      ) : rows.length === 0 ? (
        <PortalInboxEmptyState title="No scheduled messages in this window." />
      ) : (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <div className={PORTAL_DATA_TABLE_SCROLL}>
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className={PORTAL_TABLE_HEAD_ROW}>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Send date</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Recipient</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Subject</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Message</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((message) => (
                  <tr
                    key={message.id}
                    className={`${PORTAL_TABLE_TR_EXPANDABLE} cursor-pointer`}
                    onClick={() => setEditMessage(message)}
                    aria-haspopup="dialog"
                    data-attr="admin-scheduled-message-edit"
                  >
                    <td className={PORTAL_TABLE_TD}>{formatSendDate(message.sendAt)}</td>
                    <td className={PORTAL_TABLE_TD}>
                      <div className="font-medium">{message.recipientName}</div>
                      <div className="text-xs text-muted">{message.recipientEmail}</div>
                    </td>
                    <td className={`${PORTAL_TABLE_TD} max-w-[180px]`}>
                      <div className="truncate font-medium text-foreground">{message.subject}</div>
                    </td>
                    <td className={`${PORTAL_TABLE_TD} max-w-[280px]`}>
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted">{messagePreview(message.body)}</p>
                    </td>
                    <td className={`${PORTAL_TABLE_TD} capitalize ${statusClass(message.status)}`}>{message.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={Boolean(editMessage)}
        onClose={() => setEditMessage(null)}
        title="Edit scheduled message"
        description="Update when this message will be delivered and what it says."
        panelClassName="max-w-lg"
      >
        {editMessage ? (
          <ScheduleInboxComposeForm
            key={editMessage.id}
            onClose={() => setEditMessage(null)}
            onSaved={onReload}
            contacts={[]}
            editMessage={editMessage}
            showHeading={false}
            onToggleCancelled={async (cancelled: boolean) => {
              await toggleCancelled(editMessage, cancelled);
              setEditMessage(null);
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
