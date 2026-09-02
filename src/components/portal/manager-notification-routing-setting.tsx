"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BellOff, BellRing, MessageCircleMore, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  MANAGER_NOTIFICATION_CATEGORIES,
  type ManagerNotificationDestination,
} from "@/lib/manager-notification-preferences";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  normalizeManagerAutomationSettings,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import {
  MANAGER_MESSAGING_SETTINGS_HREF,
  formatManagerMessagingPhone,
  type ManagerMessagingNumberStatus,
} from "@/lib/sms/manager-messaging-number";

const DESTINATIONS: ReadonlyArray<{
  id: ManagerNotificationDestination;
  label: string;
  description: string;
  icon: typeof Smartphone;
}> = [
  {
    id: "none",
    label: "No updates",
    description: "Do not send proactive manager reminders. Your records and task lists remain available in PropLane.",
    icon: BellOff,
  },
  {
    id: "personal_number",
    label: "Text my phone",
    description: "Uses your PropLane work number and falls back to Assistant until texting is ready.",
    icon: Smartphone,
  },
  {
    id: "assistant",
    label: "PropLane Assistant",
    description: "Keep alerts in PropLane and notify this device through the app.",
    icon: MessageCircleMore,
  },
  {
    id: "both",
    label: "Both",
    description: "Notify PropLane Assistant and send a copy to your phone.",
    icon: BellRing,
  },
];

type LoadState = "loading" | "ready" | "error";

export function ManagerNotificationRoutingSetting() {
  const { showToast } = useAppUi();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<ManagerAutomationSettings>(
    DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  );
  const [numberStatus, setNumberStatus] = useState<ManagerMessagingNumberStatus | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [settingsResponse, numberResponse] = await Promise.all([
        fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" }),
        fetch("/api/manager/messaging-number", { credentials: "include", cache: "no-store" }),
      ]);
      if (!settingsResponse.ok) throw new Error("Could not load manager alert preferences.");
      const body = (await settingsResponse.json()) as { settings?: unknown };
      setSettings(normalizeManagerAutomationSettings(body.settings));
      setNumberStatus(
        numberResponse.ok ? ((await numberResponse.json()) as ManagerMessagingNumberStatus) : null,
      );
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    // Defer the initial state transition out of the effect body. This keeps the
    // effect as an external fetch synchronization without a cascading render.
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const textConnectionReady = Boolean(
    numberStatus?.canSend &&
      numberStatus.number?.phoneNumber?.trim() &&
      numberStatus.personalPhone.phone?.trim() &&
      numberStatus.personalPhone.forwardInbound,
  );
  const statusCopy = useMemo(() => {
    if (textConnectionReady) {
      return `Alerts can be sent from ${formatManagerMessagingPhone(numberStatus?.number?.phoneNumber)} to ${formatManagerMessagingPhone(numberStatus?.personalPhone.phone)}.`;
    }
    return "PropLane Assistant will keep receiving alerts until your personal phone and work number are ready.";
  }, [numberStatus, textConnectionReady]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/portal/automation-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          managerNotificationDestination: settings.managerNotificationDestination,
          managerNotificationCategories: settings.managerNotificationCategories,
        }),
      });
      if (!response.ok) throw new Error("Could not save manager alert preferences.");
      const body = (await response.json()) as { settings?: unknown };
      setSettings(normalizeManagerAutomationSettings(body.settings));
      showToast("Manager alert preferences saved.");
    } catch {
      showToast("Could not save manager alert preferences. Try again.");
    } finally {
      setSaving(false);
    }
  }, [settings, showToast]);

  return (
    <PortalSettingsSection
      title="Manager alerts"
      description="Choose where proactive reminders reach you and which topics may text your phone."
      action={
        loadState === "ready" ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-10 px-4 text-[13px]"
            disabled={saving}
            aria-busy={saving}
            onClick={() => void save()}
            data-attr="manager-alert-preferences-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        ) : null
      }
    >
      {loadState === "loading" ? (
        <div className="space-y-3" aria-label="Loading manager alert preferences">
          <div className="h-28 animate-pulse rounded-lg bg-muted/60" />
          <div className="h-40 animate-pulse rounded-lg bg-muted/60" />
        </div>
      ) : loadState === "error" ? (
        <PortalSettingsGroup>
          <div className="flex flex-col items-start gap-3 px-4 py-4">
            <div>
              <p className="text-sm font-medium text-foreground">Couldn&apos;t load manager alerts</p>
              <p className="mt-1 text-xs text-muted">Check your connection and try again.</p>
            </div>
            <Button type="button" variant="outline" className="min-h-10" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </PortalSettingsGroup>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-accent/30 px-4 py-3">
            <p className="text-sm font-medium text-foreground">
              {textConnectionReady ? "Phone connection ready" : "Assistant fallback active"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{statusCopy}</p>
            {!textConnectionReady ? (
              <Link
                href={MANAGER_MESSAGING_SETTINGS_HREF}
                className="mt-2 inline-flex min-h-10 items-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-attr="manager-alerts-open-messaging-settings"
              >
                Finish messaging setup
              </Link>
            ) : null}
          </div>

          <PortalSettingsGroup>
            <fieldset>
              <legend className="px-4 pb-2 pt-4 text-sm font-semibold text-foreground">
                Send manager alerts to
              </legend>
              {DESTINATIONS.map((destination) => {
                const Icon = destination.icon;
                return (
                  <label
                    key={destination.id}
                    className="flex min-h-14 cursor-pointer items-start gap-3 border-b border-border px-4 py-3.5 last:border-0 hover:bg-accent/30"
                  >
                    <input
                      type="radio"
                      name="manager-notification-destination"
                      value={destination.id}
                      checked={settings.managerNotificationDestination === destination.id}
                      onChange={() =>
                        setSettings((current) => ({
                          ...current,
                          managerNotificationDestination: destination.id,
                        }))
                      }
                      className="mt-1 h-4 w-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                      data-attr={`manager-alert-destination-${destination.id}`}
                    />
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{destination.label}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                        {destination.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          </PortalSettingsGroup>

          <PortalSettingsGroup>
            <fieldset>
              <legend className="px-4 pb-2 pt-4 text-sm font-semibold text-foreground">
                Text me about
              </legend>
              <p className="px-4 pb-2 text-xs leading-relaxed text-muted">
                Topics turned off here still stay available in PropLane.
              </p>
              {MANAGER_NOTIFICATION_CATEGORIES.map((category) => (
                <label
                  key={category.id}
                  className="flex min-h-14 cursor-pointer items-start gap-3 border-b border-border px-4 py-3.5 last:border-0 hover:bg-accent/30"
                >
                  <input
                    type="checkbox"
                    checked={settings.managerNotificationCategories[category.id]}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        managerNotificationCategories: {
                          ...current.managerNotificationCategories,
                          [category.id]: event.target.checked,
                        },
                      }))
                    }
                    className="mt-1 h-4 w-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                    data-attr={`manager-alert-category-${category.id}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{category.label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                      {category.description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          </PortalSettingsGroup>
        </div>
      )}
    </PortalSettingsSection>
  );
}
