"use client";

/**
 * Settings — reminders and auto-tasks in ONE surface.
 *
 * Previously these were two tabs, which made a manager hunt for which screen
 * owned "when does this go out". Each section now carries both: when reminders
 * fire, and when the auto-task is due.
 *
 * Timings are a multi-select dropdown rather than a chip grid — the grid grew
 * to nine wrapping pills per row and buried everything under it. Options carry
 * their own direction ("1 day before", "15 minutes after"), so a section is
 * self-describing and needs no explanatory subtitle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_REMINDER_SETTINGS,
  REMINDER_SUBJECT_KINDS,
  REMINDER_SUBJECT_META,
  normalizeReminderSettings,
  type ReminderSettings,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import {
  formatMinutes,
  summarizeTimings,
  timingKey,
  timingOptions,
  type TimingDirection,
} from "@/lib/reminders/timings";

/**
 * Which directions each subject offers.
 *
 * A tour or a service visit is prepared for, so it counts back. An application
 * is chased after it arrives. Tasks get both: a nudge before the due date and a
 * chase after it passes.
 */
const SUBJECT_DIRECTIONS: Record<ReminderSubjectKind, TimingDirection[]> = {
  tour: ["before"],
  task: ["before", "after"],
  service_order: ["before"],
  work_order: ["before"],
  application: ["after"],
  application_manager: ["after"],
  application_post_tour: ["after"],
  lease: ["after"],
  lease_manager: ["after"],
  payment_manager: ["after"],
  outgoing_payment: ["before"],
  // A stay is prepared for, never chased after check-in has passed.
  booking: ["before"],
};

/** Multi-select dropdown. Closes on outside click and on Escape. */
function TimingMultiSelect({
  value,
  onChange,
  directions,
  dataAttr,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  directions: TimingDirection[];
  dataAttr: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const options = useMemo(() => timingOptions(directions), [directions]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (optionValue: string) => {
    onChange(value.includes(optionValue) ? value.filter((v) => v !== optionValue) : [...value, optionValue]);
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-attr={`${dataAttr}-trigger`}
        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-border bg-transparent px-3 py-2 text-left text-[13px] text-foreground"
      >
        <span className="min-w-0 truncate">{summarizeTimings(value)}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-multiselectable
          data-attr={dataAttr}
          className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-1 shadow-lg"
        >
          {options.map((option) => {
            const checked = value.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => toggle(option.value)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-foreground hover:bg-accent"
              >
                <span
                  aria-hidden
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] ${
                    checked ? "border-primary bg-primary text-white" : "border-border"
                  }`}
                >
                  {checked ? "✓" : ""}
                </span>
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (n: boolean) => void; label: string }) {
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

export function ManagerPortalAutomationSettingsPanel() {
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULT_REMINDER_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
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
          setLoadError(body.error ?? "Could not load settings.");
          return;
        }
        setSettings(normalizeReminderSettings(body.settings));
      } catch {
        if (!cancelled) setLoadError("Could not load settings.");
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
      setStatus(body.error ?? "Could not save.");
      return;
    }
    setSettings(normalizeReminderSettings(body.settings));
    setStatus("Saved.");
  }, [settings]);

  if (loading) return <p className="py-6 text-sm text-muted">Loading…</p>;

  if (loadError) {
    return (
      <div className="py-6">
        <p className="text-sm text-muted">{loadError}</p>
        <Button
          variant="outline"
          className="mt-3"
          data-attr="automation-settings-retry"
          onClick={() => {
            setLoadError(null);
            setLoading(true);
            setReloadKey((k) => k + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
        {REMINDER_SUBJECT_KINDS.map((kind) => {
          const rule = settings.rules[kind];
          // `leadMinutes` predates directions; render legacy values as "before"
          // so an existing selection still shows rather than reading as empty.
          const selected =
            rule.timings ?? rule.leadMinutes.map((m) => timingKey({ direction: "before", minutes: m }));
          return (
            <div key={kind} className="border-b border-border py-3 last:border-b-0" data-attr={`settings-row-${kind}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13.5px] font-semibold text-foreground">{REMINDER_SUBJECT_META[kind].label}</p>
                <Toggle
                  checked={rule.enabled}
                  onChange={(enabled) =>
                    setSettings((c) => ({ ...c, rules: { ...c.rules, [kind]: { ...c.rules[kind], enabled } } }))
                  }
                  label={`${REMINDER_SUBJECT_META[kind].label} reminders`}
                />
              </div>
              {rule.enabled ? (
                <div className="mt-2">
                  <TimingMultiSelect
                    value={selected}
                    directions={SUBJECT_DIRECTIONS[kind]}
                    dataAttr={`settings-timings-${kind}`}
                    onChange={(timings) =>
                      setSettings((c) => ({ ...c, rules: { ...c.rules, [kind]: { ...c.rules[kind], timings } } }))
                    }
                  />
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="mt-4 border-t border-border pt-3" data-attr="settings-row-quiet-hours">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13.5px] font-semibold text-foreground">Quiet hours</p>
            <Toggle
              checked={settings.quietHours.enabled}
              onChange={(enabled) => setSettings((c) => ({ ...c, quietHours: { ...c.quietHours, enabled } }))}
              label="Quiet hours"
            />
          </div>
          {settings.quietHours.enabled ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <label className="flex items-center gap-2">
                From
                <select
                  className="rounded-lg border border-border bg-transparent px-2 py-1 text-foreground"
                  value={settings.quietHours.startHour}
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
                  value={settings.quietHours.endHour}
                  onChange={(e) =>
                    setSettings((c) => ({ ...c, quietHours: { ...c.quietHours, endHour: Number(e.target.value) } }))
                  }
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
                  ))}
                </select>
              </label>
              <span className="text-muted">({formatMinutes(60)} blocks)</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex shrink-0 items-center gap-3 border-t border-border pt-3">
        <Button variant="primary" onClick={() => save()} data-attr="automation-settings-save">
          Save
        </Button>
        {status ? <span className="text-xs text-muted">{status}</span> : null}
      </div>
    </div>
  );
}
