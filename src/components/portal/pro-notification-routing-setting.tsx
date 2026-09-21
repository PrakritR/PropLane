"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BellOff, BellRing, MessageCircleMore, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PortalSettingsGroup,
  PortalSettingsScopeTag,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  fetchAcrossScopeTargets,
  saveAcrossScopeTargets,
  useSettingsPropertyScope,
  type SettingsResolutionSource,
} from "@/components/portal/settings-property-scope";
import { scopeTagLabel } from "@/components/portal/settings-scope-bar";
import {
  MANAGER_NOTIFICATION_CATEGORIES,
  type ManagerAttentionDigestCadence,
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
import { trimmedText } from "@/lib/trimmed-text";

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

const DIGEST_CADENCES: ReadonlyArray<{
  id: ManagerAttentionDigestCadence;
  label: string;
  description: string;
}> = [
  { id: "off", label: "Off", description: "Do not send a scheduled summary." },
  { id: "daily", label: "Daily", description: "Send each day when something needs attention." },
  { id: "weekly", label: "Weekly", description: "Send Monday when something needs attention." },
];

type LoadState = "loading" | "ready" | "error";

export function ManagerNotificationRoutingSetting() {
  const { showToast } = useAppUi();
  const { targets, reportSource } = useSettingsPropertyScope();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<ManagerAutomationSettings>(
    DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  );
  const [source, setSource] = useState<SettingsResolutionSource | null>(null);
  /** True when the selected workspaces disagree — the fields below show the FIRST one's values; saving overwrites every selected workspace with them. */
  const [mixed, setMixed] = useState(false);
  const [numberStatus, setNumberStatus] = useState<ManagerMessagingNumberStatus | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [settingsResult, numberResponse] = await Promise.all([
        fetchAcrossScopeTargets(
          targets,
          (query) => `/api/portal/automation-settings${query}`,
          (body) => {
            const typed = body as { settings?: unknown; source?: SettingsResolutionSource };
            return { settings: normalizeManagerAutomationSettings(typed.settings), source: typed.source ?? null };
          },
          { isEqual: (a, b) => JSON.stringify(a.settings) === JSON.stringify(b.settings) },
        ),
        fetch("/api/manager/messaging-number", { credentials: "include", cache: "no-store" }),
      ]);
      setSettings(settingsResult.value.settings);
      setSource(settingsResult.value.source);
      setMixed(settingsResult.mixed);
      reportSource("automation-settings", settingsResult.value.source);
      setNumberStatus(
        numberResponse.ok ? ((await numberResponse.json()) as ManagerMessagingNumberStatus) : null,
      );
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [targets, reportSource]);

  useEffect(() => {
    // Defer the initial state transition out of the effect body. This keeps the
    // effect as an external fetch synchronization without a cascading render.
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const workNumberAssigned = Boolean(trimmedText(numberStatus?.number?.phoneNumber));
  const textConnectionReady = Boolean(
    numberStatus?.canSend &&
      workNumberAssigned &&
      trimmedText(numberStatus.personalPhone?.phone) &&
      numberStatus.personalPhone.forwardInbound,
  );
  const statusCopy = useMemo(() => {
    if (textConnectionReady) {
      return `Alerts can be sent from ${formatManagerMessagingPhone(numberStatus?.number?.phoneNumber)} to ${formatManagerMessagingPhone(numberStatus?.personalPhone.phone)}.`;
    }
    if (workNumberAssigned) {
      return `Alerts can be sent from ${formatManagerMessagingPhone(numberStatus?.number?.phoneNumber)}.`;
    }
    return "PropLane Assistant will keep receiving alerts until your personal phone and work number are ready.";
  }, [numberStatus, textConnectionReady, workNumberAssigned]);

  /**
   * Fans the write out across every selected target (one PATCH per
   * workspace, each re-authorized server-side on its own `workspaceId` —
   * see `saveAcrossScopeTargets`). When `mixed` was true, this overwrites
   * every selected workspace with the ONE value shown on screen (the first
   * target's) — the accepted bulk-edit behavior once a manager edits a
   * "Mixed" field.
   */
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const result = await saveAcrossScopeTargets(targets, "/api/portal/automation-settings", "PATCH", {
        managerNotificationDestination: settings.managerNotificationDestination,
        managerNotificationCategories: settings.managerNotificationCategories,
        managerAttentionDigestCadence: settings.managerAttentionDigestCadence,
      });
      if (!result.ok) throw new Error(result.failed[0]?.error || "Could not save manager alert preferences.");
      // Every target just got its own workspace row upserted (or, with no
      // workspace at all, the account row) — resolve the tag the same way
      // the write itself just landed rather than trusting stale GET state.
      const savedSource: SettingsResolutionSource = targets.every((t) => t.workspaceId) ? "workspace" : "account";
      setSource(savedSource);
      setMixed(false);
      reportSource("automation-settings", savedSource);
      showToast(
        targets.length > 1 ? `Manager alert preferences saved to ${targets.length} workspaces.` : "Manager alert preferences saved.",
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not save manager alert preferences. Try again.");
    } finally {
      setSaving(false);
    }
  }, [settings, showToast, targets, reportSource]);

  return (
    <PortalSettingsSection
      title="Manager alerts"
      action={
        loadState === "ready" ? (
          <div className="flex items-center gap-2">
            {mixed ? (
              <PortalSettingsScopeTag variant="muted" dataAttr="manager-alerts-mixed">
                Mixed across {targets.length} workspaces
              </PortalSettingsScopeTag>
            ) : source ? (
              <PortalSettingsScopeTag variant="muted">{scopeTagLabel(source, 0)}</PortalSettingsScopeTag>
            ) : null}
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
          </div>
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
              {workNumberAssigned ? "Phone connection ready" : "Assistant fallback active"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{statusCopy}</p>
            {!workNumberAssigned ? (
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
                Needs-attention digest
              </legend>
              <p className="px-4 pb-2 text-xs leading-relaxed text-muted">
                Uses your manager-alert destination and sends only when your queue has open items.
              </p>
              {DIGEST_CADENCES.map((cadence) => (
                <label
                  key={cadence.id}
                  className="flex min-h-14 cursor-pointer items-start gap-3 border-b border-border px-4 py-3.5 last:border-0 hover:bg-accent/30"
                >
                  <input
                    type="radio"
                    name="manager-attention-digest-cadence"
                    value={cadence.id}
                    checked={settings.managerAttentionDigestCadence === cadence.id}
                    onChange={() =>
                      setSettings((current) => ({
                        ...current,
                        managerAttentionDigestCadence: cadence.id,
                      }))
                    }
                    className="mt-1 h-4 w-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                    data-attr={`manager-attention-digest-${cadence.id}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{cadence.label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                      {cadence.description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          </PortalSettingsGroup>

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
