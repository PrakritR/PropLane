"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ReminderMessagePreviewCard,
  ReminderMessageUpdateModal,
  ReminderSendViaField,
  TourReminderTimingSelect,
} from "@/components/portal/reminder-settings-shared";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  PAYMENT_AUTOMATION_SETTINGS_EVENT,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { fillTourReminderTemplate } from "@/lib/tour-reminder";

const PREVIEW_CONTEXT = {
  guestName: "Alex Prospect",
  propertyTitle: "5257 Brooklyn Avenue Northeast",
  tourTime: "Aug 15, 2026 at 10:00 AM",
  managerName: "Your team",
  instructions: "Meet at the front door. Text when you arrive.",
};

const TOUR_PLACEHOLDERS =
  "Placeholders: {guestName}, {propertyTitle}, {tourTime}, {managerName}, {instructions}";

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
  const [messageModalOpen, setMessageModalOpen] = useState(false);
  const [draft, setDraft] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);

  useEffect(() => {
    if (!open) {
      setMessageModalOpen(false);
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
    if (!draft.tourReminderDeliverViaEmail && !draft.tourReminderDeliverViaSms) {
      showToast("Choose at least one channel under Send via.");
      return;
    }
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
          tourReminderEnabled: true,
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
    <>
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
            <TourReminderTimingSelect
              minutesBefore={draft.tourReminderMinutesBefore}
              onChangeMinutes={(minutes) =>
                setDraft((prev) => ({ ...prev, tourReminderMinutesBefore: minutes }))
              }
            />

            <ReminderSendViaField
              viaEmail={draft.tourReminderDeliverViaEmail !== false}
              viaSms={draft.tourReminderDeliverViaSms === true}
              smsLabel="SMS (when guest opted in)"
              onChange={({ viaEmail, viaSms }) =>
                setDraft((prev) => ({
                  ...prev,
                  tourReminderDeliverViaEmail: viaEmail,
                  tourReminderDeliverViaSms: viaSms,
                }))
              }
              dataAttr="tour-reminder-send-via"
            />

            <ReminderMessagePreviewCard
              subject={templatePreview.subject}
              body={templatePreview.body}
              onUpdate={() => setMessageModalOpen(true)}
              dataAttr="tour-reminder-update-message"
            />

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

      <ReminderMessageUpdateModal
        open={messageModalOpen}
        onClose={() => setMessageModalOpen(false)}
        subject={draft.templates.tourReminder.subject}
        body={draft.templates.tourReminder.body}
        placeholders={TOUR_PLACEHOLDERS}
        onSave={(next) => {
          setDraft((prev) => ({
            ...prev,
            templates: { ...prev.templates, tourReminder: next },
          }));
        }}
      />
    </>
  );
}
