"use client";

/**
 * Settings → Reminders.
 *
 * One row per remindable subject: on/off, which lead times, and which side
 * hears about it. Before the reminder spine, lead times existed only for
 * payments (in days) and tours (in minutes), and nothing shorter than a day
 * could actually be delivered.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import {
  DEFAULT_REMINDER_SETTINGS,
  LEAD_MINUTE_PRESETS,
  REMINDER_SUBJECT_KINDS,
  REMINDER_SUBJECT_META,
  formatLeadLabel,
  formatLeadSummary,
  normalizeLeadMinutesList,
  normalizeReminderSettings,
  type ReminderRule,
  type ReminderSettings,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";

const CHIP =
  "rounded-full border border-border px-3 py-1.5 text-[11.5px] font-semibold text-muted transition-colors";
const CHIP_ON = "rounded-full border border-primary bg-primary px-3 py-1.5 text-[11.5px] font-semibold text-white";

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[21px] w-[36px] shrink-0 rounded-full transition-colors ${
        checked ? "bg-primary" : "bg-border"
      }`}
    >
      <span
        className={`absolute top-[2.5px] h-4 w-4 rounded-full bg-white transition-all ${
          checked ? "right-[2.5px]" : "left-[2.5px]"
        }`}
      />
    </button>
  );
}

function SubjectRow({
  kind,
  rule,
  onChange,
}: {
  kind: ReminderSubjectKind;
  rule: ReminderRule;
  onChange: (next: ReminderRule) => void;
}) {
  const meta = REMINDER_SUBJECT_META[kind];
  // A stored lead time that is not a preset still has to be togglable, or a
  // manager could never turn off a value the picker cannot draw.
  const options = useMemo(
    () => [...new Set([...LEAD_MINUTE_PRESETS, ...rule.leadMinutes])].sort((a, b) => b - a),
    [rule.leadMinutes],
  );

  const toggleLead = useCallback(
    (minutes: number) => {
      const has = rule.leadMinutes.includes(minutes);
      const next = has
        ? rule.leadMinutes.filter((m) => m !== minutes)
        : [...rule.leadMinutes, minutes];
      // Keep at least one lead time: a rule that is "on" with nothing scheduled
      // reads as broken. Clearing the last one turns the rule off instead.
      if (next.length === 0) {
        onChange({ ...rule, enabled: false });
        return;
      }
      onChange({ ...rule, leadMinutes: normalizeLeadMinutesList(next, rule.leadMinutes) });
    },
    [onChange, rule],
  );

  return (
    <div className="border-b border-border py-4 last:border-b-0" data-attr={`reminder-row-${kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-foreground">{meta.label}</p>
          <p className="mt-0.5 text-xs text-muted">
            Counted back from {meta.anchorLabel} · {meta.counterpartyLabel}
          </p>
          <p className="mt-1 text-xs font-medium text-primary">
            {rule.enabled ? formatLeadSummary(rule.leadMinutes) : "Off"}
          </p>
        </div>
        <Toggle
          checked={rule.enabled}
          onChange={(enabled) => onChange({ ...rule, enabled })}
          label={`${meta.label} reminders`}
        />
      </div>

      {rule.enabled ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {options.map((minutes) => {
              const on = rule.leadMinutes.includes(minutes);
              return (
                <button
                  key={minutes}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleLead(minutes)}
                  className={on ? CHIP_ON : CHIP}
                >
                  {formatLeadLabel(minutes).replace(/ before$/, "")}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={rule.audience.counterparty}
                onChange={(e) => onChange({ ...rule, audience: { ...rule.audience, counterparty: e.target.checked } })}
              />
              Notify {meta.counterpartyLabel}
            </label>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={rule.audience.manager}
                onChange={(e) => onChange({ ...rule, audience: { ...rule.audience, manager: e.target.checked } })}
              />
              Notify me
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ManagerReminderSettingsPanel() {
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULT_REMINDER_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The portal can saturate the server, and a request that never returns
    // would otherwise leave this panel on "Loading…" forever with nothing to
    // click. Time out and show the defaults with a retry instead.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    void (async () => {
      try {
        const res = await fetch("/api/portal/reminder-settings", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(body.error ?? "Could not load your reminder settings.");
          return;
        }
        setSettings(normalizeReminderSettings(body.settings));
      } catch {
        if (!cancelled) setLoadError("Could not load your reminder settings.");
      } finally {
        clearTimeout(timer);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [reloadKey]);

  const save = useCallback(async () => {
    setStatus(null);
    const res = await fetch("/api/portal/reminder-settings", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
    if (!res.ok) {
      setStatus(body.error ?? "Could not save reminders.");
      return;
    }
    setSettings(normalizeReminderSettings(body.settings));
    setStatus("Saved.");
  }, [settings]);

  const quiet = settings.quietHours;

  return (
    <ManagerPortalPageShell title="Reminders" hideTitleOnMobileNav compactFilterRow>
      <div className="max-w-2xl">
        <p className="text-sm text-muted">
          Choose how far ahead each kind of reminder goes out, and who receives it. Reminders are sent by email.
        </p>

        {loading ? (
          <p className="mt-6 text-sm text-muted">Loading…</p>
        ) : loadError ? (
          <div className="mt-6">
            <p className="text-sm text-muted">{loadError}</p>
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => {
                setLoadError(null);
                setLoading(true);
                setReloadKey((k) => k + 1);
              }}
              data-attr="reminder-settings-retry"
            >
              Try again
            </Button>
          </div>
        ) : (
          <>
            <div className="mt-4" data-attr="reminder-subject-rows">
              {REMINDER_SUBJECT_KINDS.map((kind) => (
                <SubjectRow
                  key={kind}
                  kind={kind}
                  rule={settings.rules[kind]}
                  onChange={(next) =>
                    setSettings((current) => ({ ...current, rules: { ...current.rules, [kind]: next } }))
                  }
                />
              ))}
            </div>

            <div className="mt-6 rounded-2xl border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[13.5px] font-semibold text-foreground">Quiet hours</p>
                  <p className="mt-0.5 text-xs text-muted">
                    A reminder that would land inside this window is held until it ends, never sent early.
                  </p>
                </div>
                <Toggle
                  checked={quiet.enabled}
                  onChange={(enabled) => setSettings((c) => ({ ...c, quietHours: { ...c.quietHours, enabled } }))}
                  label="Quiet hours"
                />
              </div>
              {quiet.enabled ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <label className="flex items-center gap-2">
                    From
                    <select
                      className="rounded-lg border border-border bg-transparent px-2 py-1 text-foreground"
                      value={quiet.startHour}
                      onChange={(e) =>
                        setSettings((c) => ({ ...c, quietHours: { ...c.quietHours, startHour: Number(e.target.value) } }))
                      }
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    until
                    <select
                      className="rounded-lg border border-border bg-transparent px-2 py-1 text-foreground"
                      value={quiet.endHour}
                      onChange={(e) =>
                        setSettings((c) => ({ ...c, quietHours: { ...c.quietHours, endHour: Number(e.target.value) } }))
                      }
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex items-center gap-3">
              <Button variant="primary" onClick={() => save()} data-attr="reminder-settings-save">
                Save reminders
              </Button>
              {status ? <span className="text-xs text-muted">{status}</span> : null}
            </div>
          </>
        )}
      </div>
    </ManagerPortalPageShell>
  );
}
