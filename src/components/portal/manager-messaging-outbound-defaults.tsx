"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PortalSettingsField,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { ReminderSendViaField } from "@/components/portal/reminder-settings-shared";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerSmsWorkNumberHint } from "@/components/portal/manager-sms-work-number-hint";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  deliverViaFromManagerSettings,
  patchDeliverViaForKind,
} from "@/lib/manager-communication-deliver-via";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  PAYMENT_AUTOMATION_SETTINGS_EVENT,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import { formatManagerMessagingPhone } from "@/lib/sms/manager-messaging-number";

export function ManagerMessagingOutboundDefaults({
  workNumber,
  canSendSms,
}: {
  workNumber: string | null;
  canSendSms: boolean;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ManagerAutomationSettings>(DEFAULT_MANAGER_AUTOMATION_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) setDraft(DEFAULT_MANAGER_AUTOMATION_SETTINGS);
          return;
        }
        const res = await fetch("/api/portal/automation-settings", {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) throw new Error("Could not load messaging defaults.");
        const body = (await res.json()) as { settings: ManagerAutomationSettings };
        if (!cancelled) setDraft(body.settings);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load messaging defaults.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast]);

  const channels = deliverViaFromManagerSettings(draft, "messages");

  const save = useCallback(async () => {
    if (!channels.viaEmail && !channels.viaSms) {
      showToast("Choose at least one channel under Send via.");
      return;
    }
    if (channels.viaSms && !canSendSms) {
      showToast("Finish work number setup before saving SMS as a default.");
      return;
    }
    setSaving(true);
    try {
      if (demo) {
        showToast("Messaging defaults saved (demo).");
        return;
      }
      const res = await fetch("/api/portal/automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messagesDeliverViaEmail: draft.messagesDeliverViaEmail,
          messagesDeliverViaSms: draft.messagesDeliverViaSms,
        }),
      });
      if (!res.ok) throw new Error("Could not save messaging defaults.");
      window.dispatchEvent(new Event(PAYMENT_AUTOMATION_SETTINGS_EVENT));
      showToast("Messaging defaults saved.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save messaging defaults.");
    } finally {
      setSaving(false);
    }
  }, [canSendSms, channels.viaEmail, channels.viaSms, demo, draft, showToast]);

  if (loading) {
    return (
      <PortalSettingsSection
        title="Message defaults"
        description="Default channels for resident outreach and Communication compose."
      >
        <PortalSettingsGroup>
          <p className="px-4 py-5 text-sm text-muted">Loading…</p>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    );
  }

  return (
    <PortalSettingsSection
      title="Message defaults"
      description="Default Send via for resident broadcasts, Tell residents, and Communication compose."
    >
      <PortalSettingsGroup>
        <div className="space-y-4 px-4 py-4">
          <ReminderSendViaField
            viaEmail={channels.viaEmail}
            viaSms={channels.viaSms}
            smsAvailable={canSendSms}
            smsLabel={canSendSms ? "SMS" : "SMS (work number not ready)"}
            onChange={({ viaEmail, viaSms }) =>
              setDraft((prev) => patchDeliverViaForKind(prev, "messages", { viaEmail, viaSms }))
            }
            dataAttr="messaging-resident-send-via"
          />
          <ManagerSmsWorkNumberHint
            show={channels.viaSms}
            phone={workNumber}
            canSend={canSendSms}
          />
          {workNumber ? (
            <PortalSettingsField
              label="Assigned work number"
              value={formatManagerMessagingPhone(workNumber)}
            />
          ) : null}
          <div className="flex justify-end border-t border-border pt-3">
            <Button
              type="button"
              variant="outline"
              className="min-h-10 rounded-full px-4 text-xs"
              disabled={saving}
              onClick={() => void save()}
              data-attr="messaging-outbound-defaults-save"
            >
              {saving ? "Saving…" : "Save defaults"}
            </Button>
          </div>
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
