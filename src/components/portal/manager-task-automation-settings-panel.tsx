"use client";

/**
 * Settings → Task automation.
 *
 * One row per auto-generated task, grouped by the stage of the resident journey
 * it belongs to. The deadline chips read "after" or "before" from the rule's
 * own anchor, so a manager never has to remember which direction a number
 * counts — that ambiguity is the reason the anchor exists.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import {
  DEFAULT_LIFECYCLE_AUTOMATION,
  LIFECYCLE_SECTIONS,
  LIFECYCLE_SECTION_LABELS,
  LIFECYCLE_TASK_META,
  OFFSET_PRESETS,
  clampOffsetMinutes,
  describeLifecycleRule,
  formatOffset,
  lifecycleKeysForSection,
  normalizeLifecycleAutomation,
  type LifecycleTaskAutomation,
  type LifecycleTaskConfig,
  type LifecycleTaskKey,
} from "@/lib/task-lifecycle-automation";

const CHIP =
  "rounded-full border border-border px-3 py-1.5 text-[11.5px] font-semibold text-muted transition-colors";
const CHIP_ON = "rounded-full border border-primary bg-primary px-3 py-1.5 text-[11.5px] font-semibold text-white";

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

function RuleRow({
  taskKey,
  config,
  onChange,
}: {
  taskKey: LifecycleTaskKey;
  config: LifecycleTaskConfig;
  onChange: (next: LifecycleTaskConfig) => void;
}) {
  const meta = LIFECYCLE_TASK_META[taskKey];
  // A stored deadline outside the presets still has to be visible and
  // changeable, or a manager could never move off a value the picker cannot
  // draw.
  const options = useMemo(
    () => [...new Set([...OFFSET_PRESETS, clampOffsetMinutes(config.offsetMinutes)])].sort((a, b) => a - b),
    [config.offsetMinutes],
  );
  const direction = meta.anchor === "before_event" ? "before" : "after";

  return (
    <div className="border-b border-border py-4 last:border-b-0" data-attr={`task-rule-${taskKey}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-foreground">{meta.label}</p>
          <p className="mt-0.5 text-xs text-muted">Created when {meta.triggerLabel}</p>
          <p className="mt-1 text-xs font-medium text-primary">{describeLifecycleRule(taskKey, config)}</p>
        </div>
        <Toggle
          checked={config.enabled}
          onChange={(enabled) => onChange({ ...config, enabled })}
          label={`${meta.label} auto-task`}
        />
      </div>

      {config.enabled ? (
        <div className="mt-3 space-y-3">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Due {direction} {meta.triggerLabel}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {options.map((minutes) => {
                const on = clampOffsetMinutes(config.offsetMinutes) === minutes;
                return (
                  <button
                    key={minutes}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onChange({ ...config, offsetMinutes: minutes })}
                    className={on ? CHIP_ON : CHIP}
                  >
                    {formatOffset(minutes)}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border"
              checked={config.sendEmailReminder}
              onChange={(e) => onChange({ ...config, sendEmailReminder: e.target.checked })}
            />
            Email the assignee when it is created and when it comes due
          </label>
        </div>
      ) : null}
    </div>
  );
}

export function ManagerTaskAutomationSettingsPanel() {
  const [automation, setAutomation] = useState<LifecycleTaskAutomation>(DEFAULT_LIFECYCLE_AUTOMATION);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // The portal can saturate the server; without a timeout this panel would
    // sit on "Loading…" forever with nothing to click.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    void (async () => {
      try {
        const res = await fetch("/api/portal/task-automation-settings", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => ({}))) as { automation?: unknown; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(body.error ?? "Could not load task automation.");
          return;
        }
        setAutomation(normalizeLifecycleAutomation(body.automation));
      } catch {
        if (!cancelled) setLoadError("Could not load task automation.");
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
    const res = await fetch("/api/portal/task-automation-settings", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ automation }),
    });
    const body = (await res.json().catch(() => ({}))) as { automation?: unknown; error?: string };
    if (!res.ok) {
      setStatus(body.error ?? "Could not save task automation.");
      return;
    }
    setAutomation(normalizeLifecycleAutomation(body.automation));
    setStatus("Saved.");
  }, [automation]);

  return (
    <ManagerPortalPageShell title="Task automation" hideTitleOnMobileNav compactFilterRow>
      <div className="max-w-2xl">
        <p className="text-sm text-muted">
          PropLane creates these tasks for you as a resident moves from a tour to a signed lease. Choose which ones
          you want and when each is due.
        </p>

        {loading ? (
          <p className="mt-6 text-sm text-muted">Loading…</p>
        ) : loadError ? (
          <div className="mt-6">
            <p className="text-sm text-muted">{loadError}</p>
            <Button
              variant="outline"
              className="mt-3"
              data-attr="task-automation-retry"
              onClick={() => {
                setLoadError(null);
                setLoading(true);
                setReloadKey((k) => k + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : (
          <>
            {LIFECYCLE_SECTIONS.map((section) => (
              <section key={section} className="mt-6" data-attr={`task-automation-section-${section}`}>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {LIFECYCLE_SECTION_LABELS[section]}
                </h3>
                <div className="mt-1">
                  {lifecycleKeysForSection(section).map((key) => (
                    <RuleRow
                      key={key}
                      taskKey={key}
                      config={automation[key]}
                      onChange={(next) => setAutomation((cur) => ({ ...cur, [key]: next }))}
                    />
                  ))}
                </div>
              </section>
            ))}

            <div className="mt-6 flex items-center gap-3">
              <Button variant="primary" onClick={() => save()} data-attr="task-automation-save">
                Save task automation
              </Button>
              {status ? <span className="text-xs text-muted">{status}</span> : null}
            </div>
          </>
        )}
      </div>
    </ManagerPortalPageShell>
  );
}
