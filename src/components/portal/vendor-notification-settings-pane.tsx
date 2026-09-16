"use client";

/**
 * Vendor → Settings → Notifications (PLAN-0915).
 *
 * Replaces the three toggles nothing read. Every row is a label and its
 * control on the settings kit: per-topic Email / Text, the offer-expiry nudge,
 * visit reminders, the weekly summary, and the vendor's own quiet hours for
 * texts. Autosaves through `/api/vendor/notification-settings`, which is what
 * `resolveChannels` reads at send time.
 */
import { useEffect, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_VENDOR_NOTIFICATION_SETTINGS,
  VENDOR_NOTIFICATION_TOPICS,
  VENDOR_OFFER_EXPIRING_LEAD_OPTIONS,
  VENDOR_TOPIC_LABELS,
  VENDOR_VISIT_REMINDER_OPTIONS,
  normalizeVendorNotificationSettings,
  type VendorNotificationSettings,
  type VendorNotificationTopic,
} from "@/lib/vendor-notification-settings";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  PortalSettingsGroup,
  PortalSettingsLockedRow,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsSections,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${((hour + 11) % 12) + 1}:00 ${hour < 12 ? "AM" : "PM"}`,
}));

export function VendorNotificationSettingsPane() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [settings, setSettings] = useState<VendorNotificationSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (demo) {
        if (!cancelled) setSettings(DEFAULT_VENDOR_NOTIFICATION_SETTINGS);
        return;
      }
      try {
        const res = await fetch("/api/vendor/notification-settings", { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not load notification settings.");
        if (!cancelled) setSettings(normalizeVendorNotificationSettings(body.settings));
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load notification settings.");
        if (!cancelled) setSettings(DEFAULT_VENDOR_NOTIFICATION_SETTINGS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast]);

  const patch = async (next: Record<string, unknown>) => {
    const previous = settings;
    setSettings((current) => normalizeVendorNotificationSettings({ ...(current ?? DEFAULT_VENDOR_NOTIFICATION_SETTINGS), ...next, topics: { ...(current ?? DEFAULT_VENDOR_NOTIFICATION_SETTINGS).topics, ...((next.topics as object) ?? {}) }, quietHours: { ...(current ?? DEFAULT_VENDOR_NOTIFICATION_SETTINGS).quietHours, ...((next.quietHours as object) ?? {}) } }));
    if (demo) return;
    try {
      const res = await fetch("/api/vendor/notification-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
        keepalive: true,
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save notification settings.");
      setSettings(normalizeVendorNotificationSettings(body.settings));
    } catch (e) {
      setSettings(previous);
      showToast(e instanceof Error ? e.message : "Could not save notification settings.");
    }
  };

  const value = settings ?? DEFAULT_VENDOR_NOTIFICATION_SETTINGS;
  const disabled = settings === null;
  const setTopic = (topic: VendorNotificationTopic, channel: "email" | "sms", on: boolean) =>
    void patch({ topics: { [topic]: { ...value.topics[topic], [channel]: on } } });
  const visitValue = VENDOR_VISIT_REMINDER_OPTIONS.find((option) => option.timings.join(",") === value.visitReminderTimings.join(","))?.value ?? "";

  return (
    <PortalSettingsSections>
      <PortalSettingsSection title="Notifications">
        <PortalSettingsGroup>
          <PortalSettingsLockedRow label="In-app inbox" reason="Every notification is kept in your inbox." />
        </PortalSettingsGroup>
        <PortalSettingsGroup>
          {VENDOR_NOTIFICATION_TOPICS.map((topic) => (
            <PortalSettingsRow key={topic} label={VENDOR_TOPIC_LABELS[topic]} className="flex-wrap gap-y-2.5">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-2 text-xs font-medium text-muted">
                  Email
                  <PortalSettingsToggle
                    checked={value.topics[topic].email}
                    onChange={(next) => setTopic(topic, "email", next)}
                    label={`Email for ${VENDOR_TOPIC_LABELS[topic]}`}
                    disabled={disabled}
                    dataAttr={`vendor-notify-${topic}-email`}
                  />
                </span>
                <span className="flex items-center gap-2 text-xs font-medium text-muted">
                  Text
                  <PortalSettingsToggle
                    checked={value.topics[topic].sms}
                    onChange={(next) => setTopic(topic, "sms", next)}
                    label={`Text for ${VENDOR_TOPIC_LABELS[topic]}`}
                    disabled={disabled}
                    dataAttr={`vendor-notify-${topic}-sms`}
                  />
                </span>
              </div>
            </PortalSettingsRow>
          ))}
        </PortalSettingsGroup>
        <PortalSettingsGroup>
          <PortalSettingsRow label="Offer expiring soon">
            <FieldSingleSelect
              label="Offer expiring soon"
              hideLabel
              variant="cell"
                    wrapperClassName="w-44"
              options={VENDOR_OFFER_EXPIRING_LEAD_OPTIONS.map((option) => ({ value: String(option.value ?? "off"), label: option.label }))}
              value={String(value.offerExpiringLeadMinutes ?? "off")}
              onChange={(next) => void patch({ offerExpiringLeadMinutes: next === "off" ? null : Number(next) })}
              disabled={disabled}
              dataAttr="vendor-notify-offer-expiring"
            />
          </PortalSettingsRow>
          <PortalSettingsRow label="Visit reminders" className="flex-wrap gap-y-2.5">
            <div className="flex flex-wrap items-center justify-end gap-3">
              <FieldSingleSelect
                label="Visit reminders"
                hideLabel
                variant="cell"
                    wrapperClassName="w-44"
                options={VENDOR_VISIT_REMINDER_OPTIONS.map((option) => ({ value: option.value || "off", label: option.label }))}
                value={visitValue || "off"}
                onChange={(next) => void patch({ visitReminderTimings: VENDOR_VISIT_REMINDER_OPTIONS.find((option) => (option.value || "off") === next)?.timings ?? [] })}
                disabled={disabled}
                dataAttr="vendor-notify-visit-reminders"
              />
              {value.visitReminderTimings.length ? (
                <span className="flex items-center gap-2 text-xs font-medium text-muted">
                  Text
                  <PortalSettingsToggle
                    checked={value.visitReminderSms}
                    onChange={(next) => void patch({ visitReminderSms: next })}
                    label="Text visit reminders"
                    disabled={disabled}
                    dataAttr="vendor-notify-visit-reminders-sms"
                  />
                </span>
              ) : null}
            </div>
          </PortalSettingsRow>
          <PortalSettingsRow label="Weekly summary">
            <FieldSingleSelect
              label="Weekly summary"
              hideLabel
              variant="cell"
                    wrapperClassName="w-44"
              options={[
                { value: "off", label: "Off" },
                { value: "monday", label: "Monday 8:00 AM" },
              ]}
              value={value.weeklySummary}
              onChange={(next) => void patch({ weeklySummary: next })}
              disabled={disabled}
              dataAttr="vendor-notify-weekly-summary"
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
      <PortalSettingsSection title="Texts">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Quiet hours for texts" className="flex-wrap gap-y-2.5">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {value.quietHours.enabled ? (
                <>
                  <FieldSingleSelect
                    label="Quiet hours start"
                    hideLabel
                    variant="cell"
                    wrapperClassName="w-44"
                    options={HOUR_OPTIONS}
                    value={String(value.quietHours.startHour)}
                    onChange={(next) => void patch({ quietHours: { startHour: Number(next) } })}
                    disabled={disabled}
                    dataAttr="vendor-notify-quiet-start"
                  />
                  <span className="text-xs text-muted">to</span>
                  <FieldSingleSelect
                    label="Quiet hours end"
                    hideLabel
                    variant="cell"
                    wrapperClassName="w-44"
                    options={HOUR_OPTIONS}
                    value={String(value.quietHours.endHour)}
                    onChange={(next) => void patch({ quietHours: { endHour: Number(next) } })}
                    disabled={disabled}
                    dataAttr="vendor-notify-quiet-end"
                  />
                </>
              ) : null}
              <PortalSettingsToggle
                checked={value.quietHours.enabled}
                onChange={(next) => void patch({ quietHours: { enabled: next } })}
                label="Quiet hours for texts"
                disabled={disabled}
                dataAttr="vendor-notify-quiet-enabled"
              />
            </div>
          </PortalSettingsRow>
          <PortalSettingsRow label="Emergencies bypass quiet hours">
            <PortalSettingsToggle
              checked={value.emergencyBypassQuietHours}
              onChange={(next) => void patch({ emergencyBypassQuietHours: next })}
              label="Emergencies bypass quiet hours"
              disabled={disabled}
              dataAttr="vendor-notify-emergency-bypass"
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    </PortalSettingsSections>
  );
}
