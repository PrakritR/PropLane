"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ManagerPortalFilterRow, MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TR_EXPANDABLE,
  PORTAL_TABLE_TD,
  createPortalRowExpandClick,
} from "@/components/portal/portal-data-table";
import { PortalInboxEmptyState, InboxScheduledCard, ScheduledMessageDetailModal } from "@/components/portal/portal-inbox-ui";
import { readPortalApiError } from "@/lib/portal-api-error";
import {
  sendAutomationScheduledMessageNow,
  sendManualScheduledMessageNow,
  useInboxRowSelection,
} from "@/components/portal/portal-inbox-selection";
import {
  patchScheduledMessage,
  useScheduledPaymentMessages,
} from "@/components/portal/payment-schedule-ui";
import {
  threadScheduledItemFromAutomationMessage,
  threadScheduledItemFromManualMessage,
} from "@/lib/inbox-scheduled-thread";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { MANAGER_APPLICATIONS_EVENT } from "@/lib/manager-applications-storage";
import { buildManagerInboxLiveContacts } from "@/lib/manager-inbox-contacts";
import {
  INBOX_SCHEDULE_HORIZON_OPTIONS,
  inboxScheduleHorizonDays,
  sendAtWithinScheduleHorizon,
  type InboxScheduleHorizonId,
} from "@/lib/inbox-schedule-horizon";
import {
  isUpcomingScheduledInboxMessage,
  type ScheduledInboxMessageRecord,
} from "@/lib/scheduled-inbox-messages";
import { combineScheduledPaymentMessages } from "@/lib/combined-payment-reminders";
import {
  formatScheduledSendAt,
  type ScheduledPaymentMessage,
} from "@/lib/scheduled-payment-messages";

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

function scheduleRowChannelLabel(row: ScheduleRow): string {
  if (row.kind === "automation") return "Email";
  const parts: string[] = [];
  if (row.message.deliverViaEmail !== false) parts.push("Email");
  if (row.message.deliverViaSms) parts.push("SMS");
  return parts.length > 0 ? parts.join(" · ") : "Email";
}

type ScheduleRow =
  | { kind: "manual"; message: ScheduledInboxMessageRecord }
  | { kind: "automation"; message: ScheduledPaymentMessage };

function rowId(row: ScheduleRow): string {
  return row.kind === "manual" ? row.message.id : row.message.id;
}

export function ManagerInboxSchedulePanel({
  portalBase,
  filterResidentEmail,
  smsUiEnabled = false,
  smsRecipientEmails,
}: {
  portalBase: string;
  /** When set, only show scheduled messages addressed to this resident (case-insensitive). */
  filterResidentEmail?: string;
  smsUiEnabled?: boolean;
  /** Lowercased resident emails that have a phone on file and can receive SMS. */
  smsRecipientEmails?: ReadonlySet<string>;
}) {
  void portalBase;
  const { showToast } = useAppUi();
  const { userId } = useManagerUserId();
  const [horizonId, setHorizonId] = useState<InboxScheduleHorizonId>("14");
  const horizonDays = inboxScheduleHorizonDays(horizonId);

  const { messages: automationMessages, loading: automationLoading, reload: reloadAutomation } =
    useScheduledPaymentMessages({ includeHidden: true });

  const [manualMessages, setManualMessages] = useState<ScheduledInboxMessageRecord[]>([]);
  const [manualLoading, setManualLoading] = useState(true);
  const [contactTick, setContactTick] = useState(0);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const reloadManual = useCallback(async () => {
    setManualLoading(true);
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
      setManualMessages(Array.isArray(body.messages) ? body.messages : []);
    } finally {
      setManualLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void reloadManual());
  }, [reloadManual]);

  useEffect(() => {
    const bump = () => setContactTick((n) => n + 1);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, bump);
    window.addEventListener("axis-pro-relationships", bump);
    return () => {
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, bump);
      window.removeEventListener("axis-pro-relationships", bump);
    };
  }, []);

  const liveContacts = useMemo(() => {
    void contactTick;
    return buildManagerInboxLiveContacts(userId);
  }, [userId, contactTick]);

  const rows = useMemo((): ScheduleRow[] => {
    const manual: ScheduleRow[] = manualMessages
      .filter((message) => isUpcomingScheduledInboxMessage(message.sendAt, message.status))
      .map((message) => ({ kind: "manual", message }));
    const automation: ScheduleRow[] = combineScheduledPaymentMessages(automationMessages).map((message) => ({
      kind: "automation",
      message,
    }));
    const targetEmail = filterResidentEmail?.trim().toLowerCase();
    return [...manual, ...automation]
      .filter((row) => sendAtWithinScheduleHorizon(row.message.sendAt, horizonDays))
      .filter((row) => {
        if (!targetEmail) return true;
        const recipientEmail = row.kind === "manual" ? row.message.recipientEmail : row.message.residentEmail;
        return (recipientEmail ?? "").trim().toLowerCase() === targetEmail;
      })
      .sort((a, b) => a.message.sendAt.localeCompare(b.message.sendAt));
  }, [manualMessages, automationMessages, horizonDays, filterResidentEmail]);

  const editingRow = useMemo(
    () => rows.find((row) => rowId(row) === editingRowId) ?? null,
    [rows, editingRowId],
  );

  const selectableIds = useMemo(
    () => rows.filter((row) => row.message.status === "scheduled").map((row) => rowId(row)),
    [rows],
  );
  const { selectedIds, allSelected, toggleSelected, toggleSelectAll, clearSelection } =
    useInboxRowSelection(selectableIds);

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(rowId(row))),
    [rows, selectedIds],
  );

  const loading = automationLoading || manualLoading;

  const reloadAll = () => {
    void reloadAutomation();
    void reloadManual();
  };

  const toggleManualCancelled = async (message: ScheduledInboxMessageRecord, cancelled: boolean) => {
    const res = await fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(message.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ cancelled }),
    });
    if (!res.ok) {
      throw new Error(await readPortalApiError(res, "Could not update."));
    }
  };

  const openRowEditor = (row: ScheduleRow) => setEditingRowId(rowId(row));

  const sendRowNow = async (row: ScheduleRow) => {
    if (row.message.status !== "scheduled") return;
    if (row.kind === "manual") {
      await sendManualScheduledMessageNow(row.message.id);
    } else {
      await sendAutomationScheduledMessageNow(row.message.id);
    }
  };

  const bulkSendNow = async () => {
    const targets = selectedRows.filter((row) => row.message.status === "scheduled");
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      let ok = 0;
      let lastError: string | null = null;
      for (const row of targets) {
        try {
          await sendRowNow(row);
          ok += 1;
        } catch (e) {
          lastError = e instanceof Error ? e.message : "Could not send message.";
        }
      }
      if (ok === 0) {
        showToast(lastError ?? "Could not send messages.");
        return;
      }
      showToast(ok === 1 ? "Message sent." : `Sent ${ok} of ${targets.length} messages.`);
      clearSelection();
      reloadAll();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not send messages.");
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkCancelSend = async () => {
    const targets = selectedRows.filter((row) => row.message.status === "scheduled");
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      let ok = 0;
      let lastError: string | null = null;
      for (const row of targets) {
        try {
          if (row.kind === "manual") {
            await toggleManualCancelled(row.message, true);
          } else {
            await patchScheduledMessage(row.message.id, { cancelled: true });
          }
          ok += 1;
        } catch (e) {
          lastError = e instanceof Error ? e.message : "Could not cancel send.";
        }
      }
      if (ok === 0) {
        showToast(lastError ?? "Could not cancel sends.");
        return;
      }
      showToast(ok === 1 ? "Send cancelled." : `Cancelled ${ok} sends.`);
      clearSelection();
      reloadAll();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not cancel sends.");
    } finally {
      setBulkBusy(false);
    }
  };

  const renderRowEditPanel = (row: ScheduleRow) => {
    const scheduled =
      row.kind === "manual"
        ? threadScheduledItemFromManualMessage(row.message)
        : threadScheduledItemFromAutomationMessage(row.message);
    const isScheduled = row.message.status === "scheduled";
    const recipientEmail = (
      row.kind === "manual" ? row.message.recipientEmail : row.message.residentEmail
    )
      ?.trim()
      .toLowerCase();
    const smsAvailable = Boolean(
      smsUiEnabled && recipientEmail && smsRecipientEmails?.has(recipientEmail),
    );

    return (
      <div className="space-y-3">
        <button
          type="button"
          className="text-xs font-semibold text-primary hover:underline"
          onClick={() => setEditingRowId(null)}
          data-attr="schedule-panel-back"
        >
          ← All scheduled messages
        </button>
        <InboxScheduledCard
          key={scheduled.id}
          sendLabel={scheduled.sendLabel}
          subject={scheduled.subject}
          body={scheduled.body}
          meta={scheduled.meta}
          channel={scheduled.channel}
          deliverViaEmail={scheduled.deliverViaEmail}
          deliverViaSms={scheduled.deliverViaSms}
          emailAvailable
          smsAvailable={smsAvailable}
          channelEditable={row.kind === "manual" && scheduled.editable && isScheduled}
          source={scheduled.source}
          editable={scheduled.editable && isScheduled}
          busy={editBusy}
          presentation="detail"
          recipient={recipientEmail ?? undefined}
          sendAt={scheduled.sendAt}
          onCancel={() => {
            if (!isScheduled) return;
            setEditBusy(true);
            void (async () => {
              try {
                if (row.kind === "manual") {
                  await toggleManualCancelled(row.message, true);
                } else {
                  await patchScheduledMessage(row.message.id, { cancelled: true });
                }
                showToast("Send cancelled.");
                setEditingRowId(null);
                reloadAll();
              } catch (e) {
                showToast(e instanceof Error ? e.message : "Could not cancel send.");
              } finally {
                setEditBusy(false);
              }
            })();
          }}
          onSendNow={() => {
            if (!isScheduled) return;
            setEditBusy(true);
            void sendRowNow(row)
              .then(() => {
                showToast(row.kind === "manual" ? "Message sent." : "Reminder sent.");
                setEditingRowId(null);
                reloadAll();
              })
              .catch((e) => {
                showToast(e instanceof Error ? e.message : "Could not send message.");
              })
              .finally(() => setEditBusy(false));
          }}
          onSaveEdit={
            scheduled.editable && isScheduled
              ? async (next) => {
                  if (row.kind === "manual") {
                    const res = await fetch(
                      `/api/portal/scheduled-inbox-messages/${encodeURIComponent(row.message.id)}`,
                      {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({
                          subject: next.subject,
                          body: next.body,
                          ...(next.deliverViaEmail !== undefined
                            ? { deliverViaEmail: next.deliverViaEmail }
                            : {}),
                          ...(next.deliverViaSms !== undefined ? { deliverViaSms: next.deliverViaSms } : {}),
                          ...(next.sendAt ? { sendAt: next.sendAt } : {}),
                        }),
                      },
                    );
                    if (!res.ok) {
                      throw new Error(await readPortalApiError(res, "Could not save."));
                    }
                  } else {
                    await patchScheduledMessage(row.message.id, {
                      customSubject: next.subject,
                      customBody: next.body,
                      ...(next.sendAt ? { customSendAt: next.sendAt } : {}),
                    });
                  }
                  showToast("Scheduled message updated.");
                  reloadAll();
                }
              : undefined
          }
        />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <ManagerPortalFilterRow>
        <FieldSingleSelect
          hideLabel
          label="Show messages scheduled within"
          variant="pill"
          value={horizonId}
          options={INBOX_SCHEDULE_HORIZON_OPTIONS.map((opt) => ({ value: opt.id, label: opt.label }))}
          onChange={(next) => setHorizonId(next as InboxScheduleHorizonId)}
        />
        {selectedIds.size > 0 ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              disabled={bulkBusy}
              onClick={() => bulkSendNow()}
            >
              Send now
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              disabled={bulkBusy}
              onClick={() => bulkCancelSend()}
            >
              Cancel send
            </Button>
            <Button type="button" variant="outline" className="rounded-full" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        ) : null}
      </ManagerPortalFilterRow>

      {loading ? (
        <p className="text-sm text-muted">Loading schedule…</p>
      ) : rows.length === 0 ? (
        <PortalInboxEmptyState title="No scheduled messages in this window." />
      ) : (
        <>
          <div className="space-y-2 lg:hidden">
            {rows.map((row) => {
              const id = rowId(row);
              const isManual = row.kind === "manual";
              const recipientName = isManual ? row.message.recipientName : row.message.residentName;
              const recipientEmail = isManual ? row.message.recipientEmail : row.message.residentEmail;
              const topic = isManual ? "Inbox message" : row.message.chargeTitle;
              const topicMeta = isManual ? null : row.message.propertyLabel;
              const subject = row.message.subject;
              const body = row.message.body;
              const status = row.message.status;
              const sendAt = row.message.sendAt;
              const sendLabel = formatScheduledSendAt(sendAt);

              return (
                <div key={id} className={PORTAL_MOBILE_CARD_CLASS}>
                  <div className="flex items-start gap-3">
                    {status === "scheduled" ? (
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary"
                        checked={selectedIds.has(id)}
                        onChange={() => toggleSelected(id)}
                        aria-label={`Select ${subject}`}
                      />
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => openRowEditor(row)}
                      aria-haspopup="dialog"
                      data-attr="scheduled-message-edit"
                    >
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate font-semibold text-foreground">{subject}</p>
                      <span className="shrink-0 text-[11px] font-medium text-muted">{scheduleRowChannelLabel(row)}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted">
                      {recipientName} · {recipientEmail}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {[topic, topicMeta].filter(Boolean).join(" · ")}
                      {!isManual && row.message.dueDateLabel ? ` · Due ${row.message.dueDateLabel}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">{sendLabel}</p>
                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted">{messagePreview(body)}</p>
                    <p className={`mt-1.5 text-xs font-medium capitalize ${statusClass(status)}`}>{status}</p>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
            <div className={PORTAL_DATA_TABLE_SCROLL}>
              <table className={PORTAL_DATA_TABLE}>
              <thead>
                <tr className={PORTAL_TABLE_HEAD_ROW}>
                  <th className={`${MANAGER_TABLE_TH} w-10 text-left`}>
                    {selectableIds.length > 0 ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-border accent-primary"
                        checked={allSelected}
                        onChange={() => toggleSelectAll()}
                        aria-label="Select all scheduled messages"
                      />
                    ) : null}
                  </th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Send date &amp; time</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Channels</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Recipient</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Topic</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Subject</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Message</th>
                  <th className={`${MANAGER_TABLE_TH} text-left`}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const id = rowId(row);
                  const isManual = row.kind === "manual";
                  const recipientName = isManual ? row.message.recipientName : row.message.residentName;
                  const recipientEmail = isManual ? row.message.recipientEmail : row.message.residentEmail;
                  const topic = isManual ? "Inbox message" : row.message.chargeTitle;
                  const topicMeta = isManual ? null : row.message.propertyLabel;
                  const subject = row.message.subject;
                  const body = row.message.body;
                  const status = row.message.status;
                  const sendAt = row.message.sendAt;
                  const sendLabel = formatScheduledSendAt(sendAt);

                  return (
                      <tr
                        key={id}
                        className={PORTAL_TABLE_TR_EXPANDABLE}
                        onClick={createPortalRowExpandClick(() => openRowEditor(row))}
                        aria-haspopup="dialog"
                        data-attr="scheduled-message-edit"
                      >
                        <td className={`${PORTAL_TABLE_TD} w-10 align-middle`}>
                          {status === "scheduled" ? (
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border accent-primary"
                              checked={selectedIds.has(id)}
                              onChange={() => toggleSelected(id)}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`Select ${subject}`}
                            />
                          ) : null}
                        </td>
                        <td className={PORTAL_TABLE_TD}>{sendLabel}</td>
                        <td className={PORTAL_TABLE_TD}>{scheduleRowChannelLabel(row)}</td>
                        <td className={PORTAL_TABLE_TD}>
                          <div className="font-medium">{recipientName}</div>
                          <div className="text-xs text-muted">{recipientEmail}</div>
                        </td>
                        <td className={PORTAL_TABLE_TD}>
                          <div>{topic}</div>
                          {topicMeta ? <div className="text-xs text-muted">{topicMeta}</div> : null}
                          {!isManual && row.message.dueDateLabel ? (
                            <div className="text-xs text-muted">Due {row.message.dueDateLabel}</div>
                          ) : null}
                        </td>
                        <td className={`${PORTAL_TABLE_TD} max-w-[180px]`}>
                          <div className="truncate font-medium text-foreground">{subject}</div>
                        </td>
                        <td className={`${PORTAL_TABLE_TD} max-w-[240px]`}>
                          <p className="line-clamp-2 text-xs leading-relaxed text-muted">{messagePreview(body)}</p>
                        </td>
                        <td className={`${PORTAL_TABLE_TD} capitalize ${statusClass(status)}`}>{status}</td>
                      </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </div>
        </>
      )}

      <ScheduledMessageDetailModal
        open={Boolean(editingRowId)}
        onClose={() => setEditingRowId(null)}
        description="View and manage this scheduled send."
      >
        {editingRow ? <div key={editingRowId}>{renderRowEditPanel(editingRow)}</div> : null}
      </ScheduledMessageDetailModal>
    </div>
  );
}

/** @deprecated Import from payment-schedule-ui */
export { ChargeReminderList, ChargeReminderList as ScheduledReminderChips } from "@/components/portal/payment-schedule-ui";
