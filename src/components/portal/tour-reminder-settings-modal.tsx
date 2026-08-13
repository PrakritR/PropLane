"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  PAYMENT_AUTOMATION_SETTINGS_EVENT,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { fillTourReminderTemplate } from "@/lib/tour-reminder";

const fieldLabel = "mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-muted";
const PORTAL_FIELD_LABEL_CLASS = "text-xs font-semibold text-muted";

const PREVIEW_CONTEXT = {
  guestName: "Alex Prospect",
  propertyTitle: "5257 Brooklyn Avenue Northeast",
  tourTime: "Aug 15, 2026 at 10:00 AM",
  managerName: "Your team",
  instructions: "Meet at the front door. Text when you arrive.",
};

function formatMinutesBeforeLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes before tour`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hour${hours === 1 ? "" : "s"} before tour`;
  return `${hours}h ${remainder}m before tour`;
}

export function TourReminderSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { showToast } = useAppUi();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [messageEditorOpen, setMessageEditorOpen] = useState(false);
  const [draft, setDraft] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);

  useEffect(() => {
    if (!open) {
      setMessageEditorOpen(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (isDemoModeActive()) {
          if (!cancelled) setDraft(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
          return;
        }
        const res = await fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" });
        if (!res.ok) throw new Error("Could not load reminder settings.");
        const body = (await res.json()) as { settings: ManagerAutomationSettings };
        if (!cancelled) setDraft(body.settings);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load reminder settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, showToast]);

  const templatePreview = useMemo(
    () => fillTourReminderTemplate(draft.templates.tourReminder, PREVIEW_CONTEXT),
    [draft.templates.tourReminder],
  );

  const save = async () => {
    setSaving(true);
    try {
      if (isDemoModeActive()) {
        showToast("Tour reminder defaults saved (demo).");
        onClose();
        return;
      }
      const res = await fetch("/api/portal/automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tourReminderEnabled: draft.tourReminderEnabled,
          tourReminderMinutesBefore: draft.tourReminderMinutesBefore,
          tourReminderDeliverViaEmail: draft.tourReminderDeliverViaEmail,
          tourReminderDeliverViaSms: draft.tourReminderDeliverViaSms,
          templates: { tourReminder: draft.templates.tourReminder },
        }),
      });
      if (!res.ok) throw new Error("Could not save tour reminder settings.");
      const body = (await res.json()) as { settings: ManagerAutomationSettings };
      setDraft(body.settings);
      window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
      showToast("Tour reminder settings saved.");
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save tour reminder settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tour reminders"
      dense
      assistantContext="Tour reminders modal"
      panelClassName="max-w-md p-3 sm:p-4"
    >
      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              checked={draft.tourReminderEnabled !== false}
              onChange={(e) => setDraft((prev) => ({ ...prev, tourReminderEnabled: e.target.checked }))}
              data-attr="tour-reminder-enabled"
            />
            Send reminders for confirmed tours
          </label>

          <div className="space-y-2">
            <p className={PORTAL_FIELD_LABEL_CLASS}>Reminder timing</p>
            <div className="flex flex-wrap items-center gap-2">
              {[15, 30, 60, 120].map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  disabled={draft.tourReminderEnabled === false}
                  onClick={() => setDraft((prev) => ({ ...prev, tourReminderMinutesBefore: minutes }))}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    draft.tourReminderMinutesBefore === minutes
                      ? "border-primary bg-primary/[0.12] text-primary"
                      : "border-border bg-card text-muted hover:border-primary/30"
                  }`}
                  data-attr={`tour-reminder-preset-${minutes}`}
                >
                  {formatMinutesBeforeLabel(minutes)}
                </button>
              ))}
            </div>
            <label className={fieldLabel}>
              Custom minutes before tour
              <Input
                type="number"
                min={5}
                max={1440}
                className="mt-1.5"
                disabled={draft.tourReminderEnabled === false}
                value={draft.tourReminderMinutesBefore}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    tourReminderMinutesBefore: Math.max(5, Math.min(1440, Number(e.target.value) || 30)),
                  }))
                }
                data-attr="tour-reminder-minutes-before"
              />
            </label>
          </div>

          <fieldset className="space-y-2" disabled={draft.tourReminderEnabled === false}>
            <legend className={fieldLabel.replace("mb-1.5 ", "")}>Send via</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.tourReminderDeliverViaEmail !== false}
                onChange={(e) => setDraft((prev) => ({ ...prev, tourReminderDeliverViaEmail: e.target.checked }))}
                data-attr="tour-reminder-via-email"
              />
              Email
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.tourReminderDeliverViaSms === true}
                onChange={(e) => setDraft((prev) => ({ ...prev, tourReminderDeliverViaSms: e.target.checked }))}
                data-attr="tour-reminder-via-sms"
              />
              SMS (when guest opted in)
            </label>
          </fieldset>

          <div className="rounded-xl border border-border bg-card px-3 py-2.5">
            <p className={PORTAL_FIELD_LABEL_CLASS}>Message</p>
            <p className="mt-1 truncate text-sm font-medium text-foreground">
              {templatePreview.subject || "Tour reminder"}
            </p>
            <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted">{templatePreview.body}</p>
            <button
              type="button"
              className="mt-2 text-xs font-semibold text-primary hover:underline"
              onClick={() => setMessageEditorOpen((open) => !open)}
              data-attr="tour-reminder-update-message"
            >
              {messageEditorOpen ? "Hide editor" : "Update message"}
            </button>
          </div>

          {messageEditorOpen ? (
            <div className="space-y-3 rounded-xl border border-border bg-accent/20 px-3 py-3">
              <label className={fieldLabel}>
                Default subject
                <Input
                  className="mt-1.5"
                  value={draft.templates.tourReminder.subject}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      templates: { ...prev.templates, tourReminder: { ...prev.templates.tourReminder, subject: e.target.value } },
                    }))
                  }
                  data-attr="tour-reminder-template-subject"
                />
              </label>

              <label className={fieldLabel}>
                Default message
                <Textarea
                  className="mt-1.5 min-h-[10rem] font-mono text-xs"
                  value={draft.templates.tourReminder.body}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      templates: { ...prev.templates, tourReminder: { ...prev.templates.tourReminder, body: e.target.value } },
                    }))
                  }
                  data-attr="tour-reminder-template-body"
                />
              </label>
              <p className="text-xs text-muted">
                Placeholders: {"{guestName}"}, {"{propertyTitle}"}, {"{tourTime}"}, {"{managerName}"}, {"{instructions}"}
              </p>
            </div>
          ) : null}

          <p className="text-xs text-muted">
            New confirmed tours get this reminder automatically. Open any confirmed tour on the calendar to edit that
            tour&apos;s message before it sends.
          </p>

          <div className="flex justify-end border-t border-border pt-3">
            <Button
              type="button"
              variant="primary"
              className="w-full rounded-full sm:w-auto"
              disabled={saving}
              onClick={() => void save()}
              data-attr="tour-reminder-settings-save"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
