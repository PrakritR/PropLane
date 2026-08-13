"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { formatTourReminderTimingLabel } from "@/components/portal/reminder-settings-shared";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { formatPacificDateTime } from "@/lib/pacific-time";

function formatSendAtLabel(sendAt: string): string {
  const d = new Date(sendAt);
  if (Number.isNaN(d.getTime())) return sendAt;
  return formatPacificDateTime(d);
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
  const [saving, setSaving] = useState(false);
  const [reminders, setReminders] = useState<ScheduledInboxMessageRecord[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendAtLocal, setSendAtLocal] = useState("");

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
      const primary = currentList[0] ?? null;
      if (primary) {
        setSubject(primary.subject);
        setBody(primary.body);
        const d = new Date(primary.sendAt);
        if (!Number.isNaN(d.getTime())) {
          const pad = (n: number) => String(n).padStart(2, "0");
          setSendAtLocal(
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
          );
        }
      }
    } catch {
      // Never surface the raw error text. The only deliberate throw above already
      // carries exactly this copy, so nothing is lost — but an unexpected failure
      // (network blip, bad JSON) was putting an internal message like
      // "Failed to parse URL from /api/portal/tour-reminders?…" in front of the
      // manager, and because this panel loads when the tour modal OPENS, that
      // toast also landed on top of the cancel/confirm result they were reading.
      showToast("Could not load tour reminder.");
    } finally {
      setLoading(false);
    }
  }, [instructions, plannedEventId, propertyTitle, recipientEmail, recipientName, showToast, tourEndIso, tourStartIso]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!recipientEmail?.includes("@")) return;
    setSaving(true);
    try {
      const sendAt =
        reminders.length === 1 && sendAtLocal ? new Date(sendAtLocal).toISOString() : undefined;
      const res = await fetch("/api/portal/tour-reminders", {
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
          subject,
          body,
          sendAt,
        }),
      });
      if (!res.ok) throw new Error("Could not save tour reminder.");
      const data = (await res.json()) as {
        reminder: ScheduledInboxMessageRecord | null;
        reminders?: ScheduledInboxMessageRecord[];
      };
      const nextList = data.reminders ?? (data.reminder ? [data.reminder] : []);
      setReminders(nextList);
      showToast(nextList.length > 1 ? "Tour reminders saved." : "Tour reminder saved.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save tour reminder.");
    } finally {
      setSaving(false);
    }
  };

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

  const reminder = reminders[0];
  const scheduledReminders = reminders.filter((row) => row.status === "scheduled");
  const commsHref = `${managerPortalBase}/communication?recipient=${encodeURIComponent(recipientEmail)}`;

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card px-4 py-3" data-attr="tour-reminder-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">
            Tour reminder{reminders.length > 1 ? "s" : ""}
          </p>
          {scheduledReminders.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-muted">
              {scheduledReminders.map((row) => (
                <li key={row.id}>
                  <span className="font-semibold text-foreground">Scheduled</span>
                  {row.tourReminderMinutesBefore != null ? (
                    <> · {formatTourReminderTimingLabel(row.tourReminderMinutesBefore)}</>
                  ) : null}
                  {" · sends "}
                  {formatSendAtLabel(row.sendAt)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-muted">
              Status: <span className="font-semibold text-foreground">{reminder.status}</span>
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            {reminder.deliverViaEmail ? "Email" : null}
            {reminder.deliverViaEmail && reminder.deliverViaSms ? " · " : null}
            {reminder.deliverViaSms ? "SMS" : null}
            {!reminder.deliverViaEmail && !reminder.deliverViaSms ? "Inbox only" : null}
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

      {scheduledReminders.length > 0 ? (
        <div className="space-y-2">
          {scheduledReminders.length === 1 ? (
            <label className="block text-xs font-semibold text-muted">
              Send at
              <Input
                type="datetime-local"
                className="mt-1"
                value={sendAtLocal}
                onChange={(e) => setSendAtLocal(e.target.value)}
                data-attr="tour-reminder-send-at"
              />
            </label>
          ) : null}
          <label className="block text-xs font-semibold text-muted">
            Subject
            <Input className="mt-1" value={subject} onChange={(e) => setSubject(e.target.value)} data-attr="tour-reminder-subject" />
          </label>
          <label className="block text-xs font-semibold text-muted">
            Message
            <Textarea className="mt-1 min-h-[8rem]" value={body} onChange={(e) => setBody(e.target.value)} data-attr="tour-reminder-body" />
          </label>
          <Button type="button" variant="primary" className="rounded-full" disabled={saving} onClick={() => save()} data-attr="tour-reminder-save">
            {saving ? "Saving…" : scheduledReminders.length > 1 ? "Save reminders" : "Save reminder"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted">These reminders were already sent. Open Communication to view the thread.</p>
      )}
    </div>
  );
}
