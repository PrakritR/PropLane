"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Inbox } from "lucide-react";

import {
  PortalSettingsGroup,
  PortalSettingsLockedRow,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { ChannelPreference, NotificationCategory, NotificationPreferences } from "@/lib/notification-preferences";

type SmsAvailability =
  | { available: true }
  | { available: false; reason: "no_phone" }
  | { available: false; reason: "opted_out"; message: string };

type ApiResponse = {
  categories?: NotificationCategory[];
  preferences?: NotificationPreferences;
  sms?: SmsAvailability;
  error?: string;
};

type RowStatus = "idle" | "saving" | "saved" | "error";

/**
 * Display copy only — the category list and channel shape are owned by
 * `@/lib/notification-preferences`. If that module ever adds or renames a
 * category, `CATEGORY_COPY` needs a matching entry or the row falls back to a
 * humanized key below, it never silently disappears.
 */
const CATEGORY_COPY: Record<NotificationCategory, { label: string; description: string }> = {
  messages: { label: "Messages", description: "New messages from your property manager." },
  leases: { label: "Lease", description: "Lease signing, renewal, and move-out updates." },
  payments: { label: "Payments", description: "Rent charges, receipts, and payment reminders." },
  maintenance: { label: "Maintenance", description: "Updates on service and maintenance requests." },
  applications: { label: "Applications", description: "Updates on applications you've submitted." },
  voice_calls: { label: "Phone calls", description: "Summaries of phone calls related to your home." },
  account: { label: "Account & security", description: "Verification, password, and account-safety notices." },
};

function categoryCopy(category: NotificationCategory) {
  return CATEGORY_COPY[category] ?? { label: category, description: "" };
}

const DEMO_PREFERENCES: NotificationPreferences = {
  messages: { inbox: true, email: true, sms: true },
  leases: { inbox: true, email: true, sms: true },
  payments: { inbox: true, email: true, sms: true },
  maintenance: { inbox: true, email: true, sms: true },
  applications: { inbox: true, email: true, sms: true },
  voice_calls: { inbox: true, email: true, sms: true },
  account: { inbox: true, email: true, sms: true },
};

const DEMO_CATEGORIES: NotificationCategory[] = [
  "messages",
  "leases",
  "payments",
  "maintenance",
  "applications",
  "voice_calls",
  "account",
];

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resident notification preferences: one row per category, with independent
 * email/text toggles. The in-app inbox is always on and is never rendered as
 * a switch — `PortalSettingsLockedRow` states why. Each toggle autosaves
 * immediately (PATCH `/api/portal/resident-notification-preferences`) and
 * shows saving/saved/failed inline; a failed save reverts the toggle and
 * surfaces a toast rather than silently keeping the stale optimistic value.
 */
export function ResidentNotificationPreferencesSettings() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(demo ? "ready" : "loading");
  const [categories, setCategories] = useState<NotificationCategory[]>(demo ? DEMO_CATEGORIES : []);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(
    demo ? DEMO_PREFERENCES : null,
  );
  const [sms, setSms] = useState<SmsAvailability | null>(demo ? { available: true } : null);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  const savedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    if (demo) return;
    setLoadState("loading");
    try {
      const res = await fetch("/api/portal/resident-notification-preferences", {
        credentials: "include",
        cache: "no-store",
      });
      const body = (await res.json()) as ApiResponse;
      if (!res.ok || !body.preferences || !body.categories) {
        throw new Error(body.error ?? "Could not load notification preferences.");
      }
      setCategories(body.categories);
      setPreferences(body.preferences);
      setSms(body.sms ?? null);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [demo]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timers = savedTimers.current;
    return () => {
      for (const timer of Object.values(timers)) clearTimeout(timer);
    };
  }, []);

  const setStatus = useCallback((category: NotificationCategory, status: RowStatus) => {
    setRowStatus((prev) => ({ ...prev, [category]: status }));
    const key = category;
    if (savedTimers.current[key]) clearTimeout(savedTimers.current[key]);
    if (status === "saved") {
      savedTimers.current[key] = setTimeout(() => {
        setRowStatus((prev) => (prev[key] === "saved" ? { ...prev, [key]: "idle" } : prev));
      }, 2500);
    }
  }, []);

  const toggle = useCallback(
    async (category: NotificationCategory, channel: "email" | "sms", nextValue: boolean) => {
      if (!preferences) return;
      const previous = preferences;
      const optimistic: NotificationPreferences = {
        ...previous,
        [category]: { ...previous[category], [channel]: nextValue },
      };

      if (demo) {
        setPreferences(optimistic);
        showToast("Notification preferences are simulated in this demo.");
        return;
      }

      setPreferences(optimistic);
      setStatus(category, "saving");
      try {
        const res = await fetch("/api/portal/resident-notification-preferences", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preferences: { [category]: { [channel]: nextValue } } }),
        });
        if (!res.ok) {
          const message = await readApiError(res, "Could not save notification preferences.");
          throw new Error(message);
        }
        const body = (await res.json()) as ApiResponse;
        if (body.preferences) setPreferences(body.preferences);
        if (body.sms) setSms(body.sms);
        setStatus(category, "saved");
      } catch (cause) {
        // Revert to server truth rather than keeping the optimistic flip — a
        // failed save must never look like a successful one.
        setPreferences(previous);
        setStatus(category, "error");
        showToast(cause instanceof Error ? cause.message : "Could not save notification preferences.");
      }
    },
    [demo, preferences, setStatus, showToast],
  );

  const rowMeta = (category: NotificationCategory): string | undefined => {
    const status = rowStatus[category] ?? "idle";
    if (status === "saving") return "Saving…";
    if (status === "saved") return "Saved";
    if (status === "error") return "Could not save — try again.";
    return undefined;
  };

  const smsDisabled = !sms || sms.available === false;
  const smsReason =
    sms && sms.available === false
      ? sms.reason === "no_phone"
        ? "Add a phone number in Messaging settings to turn on text notifications."
        : sms.message
      : undefined;

  return (
    <PortalSettingsSection
      title="Notification preferences"
    >
      {loadState === "loading" ? (
        <PortalSettingsGroup>
          <div className="px-4 py-6 text-sm text-muted">Loading notification preferences…</div>
        </PortalSettingsGroup>
      ) : loadState === "error" ? (
        <PortalSettingsGroup>
          <div className="space-y-2 px-4 py-6">
            <p className="text-sm text-danger" role="alert">
              Could not load notification preferences.
            </p>
            <button
              type="button"
              className="text-xs font-medium text-primary underline underline-offset-2"
              onClick={() => void load()}
              data-attr="resident-notification-preferences-retry"
            >
              Try again
            </button>
          </div>
        </PortalSettingsGroup>
      ) : (
        <>
          <PortalSettingsGroup>
            <PortalSettingsLockedRow
              label={
                <span className="flex items-center gap-1.5">
                  <Inbox className="h-3.5 w-3.5" aria-hidden />
                  In-app inbox
                </span>
              }
              reason="Always on — the durable record of every notification. It cannot be turned off."
            />
          </PortalSettingsGroup>

          {smsDisabled && smsReason ? (
            <p className="text-xs leading-relaxed text-muted" role="status">
              {smsReason}
            </p>
          ) : null}

          <PortalSettingsGroup>
            {(categories.length ? categories : DEMO_CATEGORIES).map((category) => {
              const copy = categoryCopy(category);
              const channelPref: ChannelPreference =
                preferences?.[category] ?? { inbox: true, email: true, sms: true };
              return (
                <PortalSettingsRow
                  key={category}
                  label={copy.label}
                >
                  <div className="flex items-center gap-5">
                    {rowMeta(category) ? (
                      <span aria-live="polite" className="text-[11.5px] font-semibold text-muted">
                        {rowMeta(category)}
                      </span>
                    ) : null}
                    <label className="flex items-center gap-2 text-xs font-medium text-muted">
                      Email
                      <PortalSettingsToggle
                        checked={channelPref.email}
                        onChange={(next) => void toggle(category, "email", next)}
                        label={`Email for ${copy.label}`}
                        dataAttr={`resident-notification-${category}-email`}
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs font-medium text-muted">
                      Text
                      <PortalSettingsToggle
                        checked={channelPref.sms}
                        onChange={(next) => void toggle(category, "sms", next)}
                        disabled={smsDisabled}
                        label={`Text for ${copy.label}`}
                        dataAttr={`resident-notification-${category}-sms`}
                      />
                    </label>
                  </div>
                </PortalSettingsRow>
              );
            })}
          </PortalSettingsGroup>
        </>
      )}
    </PortalSettingsSection>
  );
}
