"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { formatTourReminderTimingLabel } from "@/components/portal/reminder-settings-shared";
import { patchScheduledMessage } from "@/components/portal/payment-schedule-ui";
import { InboxScheduledCard } from "@/components/portal/portal-inbox-ui";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { formatScheduledSendAt } from "@/lib/scheduled-payment-messages";

function formatSendDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function tourReminderCardLabel(row: ScheduledInboxMessageRecord): string {
  if (row.tourReminderMinutesBefore != null) {
    return formatTourReminderTimingLabel(row.tourReminderMinutesBefore);
  }
  return "Before tour";
}

export function TourReminderTourPanel({
  plannedEventId,
  tourStartIso,
  tourEndIso,
  recipientEmail,
  recipientName,
  propertyTitle,
  instructions,
  managerPortalBase = "/portal",
}: {
  plannedEventId: string;
  tourStartIso: string;
  tourEndIso: string;
  recipientEmail?: string;
  recipientName?: string;
  propertyTitle?: string;
  instructions?: string;
  managerPortalBase?: string;
}) {
  const { showToast } = useAppUi();
  const [loading, setLoading] = useState(true);
  const [reminders, setReminders] = useState<ScheduledInboxMessageRecord[]>([]);
  const [editingReminder, setEditingReminder] = useState<ScheduledInboxMessageRecord | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const manageable = useMemo(
    () => reminders.filter((row) => row.status === "scheduled" || row.status === "cancelled"),
    [reminders],
  );

  const load = useCallback(async () => {
    if (!recipientEmail?.includes("@")) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/portal/tour-reminders?plannedEventId=${encodeURIComponent(plannedEventId)}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!res.ok) throw new Error("Could not load tour reminder.");
      let data = (await res.json()) as {
        reminder: ScheduledInboxMessageRecord | null;
        reminders?: ScheduledInboxMessageRecord[];
      };
      let currentList = data.reminders ?? (data.reminder ? [data.reminder] : []);
      if (!currentList.length) {
        const upsert = await fetch("/api/portal/tour-reminders", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plannedEventId,
            tourStartIso,
            tourEndIso,
            recipientEmail,
            recipientName,
            propertyTitle,
            instructions,
          }),
        });
        if (upsert.ok) {
          data = (await upsert.json()) as {
            reminder: ScheduledInboxMessageRecord | null;
            reminders?: ScheduledInboxMessageRecord[];
          };
          currentList = data.reminders ?? (data.reminder ? [data.reminder] : []);
        }
      }
      setReminders(currentList);
    } catch {
      showToast("Could not load tour reminder.");
    } finally {
      setLoading(false);
    }
  }, [instructions, plannedEventId, propertyTitle, recipientEmail, recipientName, showToast, tourEndIso, tourStartIso]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleCancelled = async (message: ScheduledInboxMessageRecord, cancelled: boolean) => {
    const previous = reminders;
    setReminders((prev) =>
      prev.map((row) =>
        row.id === message.id ? { ...row, status: cancelled ? "cancelled" : "scheduled" } : row,
      ),
    );
    try {
      await patchScheduledMessage(message.id, { cancelled });
      await load();
    } catch {
      setReminders(previous);
      showToast("Could not update reminder.");
    }
  };

  const editingSendLabel = editingReminder ? formatScheduledSendAt(editingReminder.sendAt) : "";

  if (!recipientEmail?.includes("@")) {
    return (
      <div className="rounded-2xl border border-border bg-accent/20 px-4 py-3 text-sm text-muted">
        Add a guest email to schedule a tour reminder.
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm text-muted">Loading tour reminder…</p>;
  }

  if (!reminders.length) {
    return (
      <div className="rounded-2xl border border-border bg-accent/20 px-4 py-3 text-sm text-muted">
        Reminder not scheduled — the tour may be too soon, or tour reminders are turned off in settings.
      </div>
    );
  }

  const primary = reminders[0];
  const commsHref = `${managerPortalBase}/communication?recipient=${encodeURIComponent(recipientEmail)}`;

  return (
    <>
      <div className="space-y-3 rounded-2xl border border-border bg-card px-4 py-3" data-attr="tour-reminder-panel">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Tour reminders</p>
            <p className="mt-1 text-xs text-muted">
              {primary.deliverViaEmail ? "Email" : null}
              {primary.deliverViaEmail && primary.deliverViaSms ? " · " : null}
              {primary.deliverViaSms ? "SMS" : null}
              {!primary.deliverViaEmail && !primary.deliverViaSms ? "Inbox only" : null}
            </p>
          </div>
          <Link
            href={commsHref}
            className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
            data-attr="tour-reminder-open-communication"
          >
            Open in Communication
          </Link>
        </div>

        {manageable.length === 0 ? (
          <p className="text-sm text-muted">These reminders were already sent. Open Communication to view the thread.</p>
        ) : (
          <div>
            <p className="text-xs font-semibold text-muted">Scheduled messages</p>
            <ul className="mt-2 space-y-2">
              {manageable.map((row) => {
                const cancelled = row.status === "cancelled";
                const label = tourReminderCardLabel(row);
                return (
                  <li
                    key={row.id}
                    className={`rounded-xl border border-border bg-card px-3 py-2.5 text-foreground shadow-sm ${
                      cancelled ? "opacity-80" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        className={`min-w-0 flex-1 text-left ${cancelled ? "line-through" : ""}`}
                        onClick={() => setEditingReminder(row)}
                        data-attr="tour-reminder-card"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">{label}</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              cancelled ? "bg-muted/30 text-muted" : "bg-primary/15 text-primary"
                            }`}
                          >
                            {cancelled ? "Off" : "Scheduled"}
                          </span>
                        </div>
                        <span className="mt-1 block text-xs text-muted">Sends {formatSendDate(row.sendAt)}</span>
                        <span className="mt-0.5 block text-[11px] font-medium text-primary">Update message</span>
                      </button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 shrink-0 rounded-full px-3 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleCancelled(row, !cancelled);
                        }}
                        data-attr="tour-reminder-toggle"
                      >
                        {cancelled ? "Turn on" : "Turn off"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <Modal
        open={Boolean(editingReminder)}
        onClose={() => setEditingReminder(null)}
        title="Scheduled message"
        dense
        panelClassName="max-w-lg p-3 sm:p-4"
      >
        {editingReminder ? (
          <InboxScheduledCard
            key={editingReminder.id}
            sendLabel={editingSendLabel}
            subject={editingReminder.subject}
            body={editingReminder.body}
            meta="Placeholders are filled when the reminder sends."
            source="automation"
            editable={editingReminder.status === "scheduled"}
            busy={detailBusy}
            presentation="detail"
            onCancel={() => void toggleCancelled(editingReminder, true).then(() => setEditingReminder(null))}
            onSendNow={() => {}}
            showSendActions={false}
            onSaveEdit={
              editingReminder.status === "scheduled"
                ? async (next) => {
                    setDetailBusy(true);
                    try {
                      await patchScheduledMessage(editingReminder.id, {
                        customSubject: next.subject,
                        customBody: next.body,
                      });
                      await load();
                      setEditingReminder(null);
                    } catch (e) {
                      showToast(e instanceof Error ? e.message : "Could not save reminder.");
                    } finally {
                      setDetailBusy(false);
                    }
                  }
                : undefined
            }
          />
        ) : null}
      </Modal>
    </>
  );
}
