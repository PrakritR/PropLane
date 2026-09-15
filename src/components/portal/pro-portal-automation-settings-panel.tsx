"use client";

/**
 * The Notifications hub — reminders and manager alert routing in ONE surface.
 *
 * This is the `/portal/settings/automation` module (the id and URL segment
 * stay `automation`; only the nav label and this panel's shape changed — see
 * `portal-settings-section.ts`). Before the commit this panel shipped on, the
 * tab was unreachable in the product (nothing ever passed
 * `initialTab="automation"`), so every control here is a rebuild, not a
 * preserved working screen.
 *
 * Top to bottom:
 * 1. Cross-cutting choices that apply to everything below: where YOU (the
 *    manager) are reached (`ManagerNotificationRoutingSetting`, already real
 *    and wired at `/api/portal/automation-settings` — reused here, not
 *    rebuilt) and quiet hours (this panel's own state, from
 *    `/api/portal/reminder-settings`).
 * 2. The event matrix, grouped by the same module mapping co-manager
 *    permissions use, with the resident/counterparty + manager-alert kind
 *    pairs merged into one row each.
 * 3. The read-only Sent history log.
 *
 * Timings are a multi-select dropdown rather than a chip grid — the grid grew
 * to nine wrapping pills per row and buried everything under it. Options carry
 * their own direction ("1 day before", "15 minutes after"), so a section is
 * self-describing and needs no explanatory subtitle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_REMINDER_SETTINGS,
  REMINDER_SUBJECT_KINDS,
  REMINDER_SUBJECT_META,
  normalizeReminderSettings,
  type ReminderRule,
  type ReminderSettings,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import { fixedRuleFields } from "@/lib/reminders/fixed-rule-fields";
import {
  formatMinutes,
  summarizeTimings,
  timingKey,
  timingOptions,
  type TimingDirection,
} from "@/lib/reminders/timings";
import { ManagerNotificationRoutingSetting } from "@/components/portal/pro-notification-routing-setting";
import { ReminderSentHistory } from "@/components/portal/reminder-sent-history";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsScopeTag,
  PortalSettingsSection,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import { CO_MANAGER_PERMISSION_OPTIONS, type CoManagerPermissionId } from "@/lib/co-manager-permissions";

/**
 * Which directions each subject offers.
 *
 * A tour or a service visit is prepared for, so it counts back. An application
 * is chased after it arrives. Tasks get both: a nudge before the due date and a
 * chase after it passes.
 */
/** 00:00 … 23:00 — the quiet-hours pickers, Pacific wall time. */
const QUIET_HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));

const SUBJECT_DIRECTIONS: Record<ReminderSubjectKind, TimingDirection[]> = {
  tour: ["before"],
  tour_interest: ["after"],
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
  inspection: ["before", "after"],
  inspection_manager: ["after"],
};

/**
 * Copy says "service", never "work order" (AGENTS.md: "There are no
 * 'work orders' in the product — only services"). `REMINDER_SUBJECT_META`'s
 * own label stays `rules.ts`'s business — this is a display-only override
 * local to this panel, not a change to the underlying kind or its schema name.
 */
const ROW_LABEL_OVERRIDE: Partial<Record<ReminderSubjectKind, string>> = {
  work_order: "Service visit",
};

function rowLabel(kind: ReminderSubjectKind): string {
  return ROW_LABEL_OVERRIDE[kind] ?? REMINDER_SUBJECT_META[kind].label;
}

/**
 * Client-safe mirror of `REMINDER_SUBJECT_CO_MANAGER_MODULE`
 * (`src/lib/co-manager-notification-recipients.server.ts`). That file is
 * `server-only` (it queries the database for co-manager recipients), so this
 * browser-rendered hub cannot import it directly — this is the same mapping,
 * copied as pure data. Keep the two byte-identical; the server file remains
 * the single source of truth for "which module does this reminder belong to".
 */
const REMINDER_KIND_MODULE: Record<ReminderSubjectKind, CoManagerPermissionId> = {
  tour: "calendar",
  tour_interest: "inbox",
  task: "calendar",
  service_order: "services",
  work_order: "services",
  application: "applications",
  application_manager: "applications",
  application_post_tour: "applications",
  lease: "leases",
  lease_manager: "leases",
  payment_manager: "payments",
  outgoing_payment: "financials",
  booking: "calendar",
  inspection: "residents",
  inspection_manager: "residents",
};

/** Same module labels the co-manager permissions editor already shows — one taxonomy, not a second one invented for this hub. */
const MODULE_LABEL: Partial<Record<CoManagerPermissionId, string>> = Object.fromEntries(
  CO_MANAGER_PERMISSION_OPTIONS.map((option) => [option.id, option.label]),
);

/** Display order = first appearance walking `REMINDER_SUBJECT_KINDS`, deduped. */
const MODULE_ORDER: CoManagerPermissionId[] = [];
for (const kind of REMINDER_SUBJECT_KINDS) {
  const moduleId = REMINDER_KIND_MODULE[kind];
  if (!MODULE_ORDER.includes(moduleId)) MODULE_ORDER.push(moduleId);
}

/**
 * The resident/counterparty kind and its manager-alert twin, merged into one
 * row: the counterparty-facing kind is primary, `managerKind` is folded into
 * the same row as an "Also alert you" sub-control, and `description` is that
 * row's second line. Both kinds of a pair always share one module (see
 * `REMINDER_KIND_MODULE` above), so merging never crosses a module boundary.
 */
type PairedEscalation = { managerKind: ReminderSubjectKind; description: string };

const PAIRED_ESCALATIONS: Partial<Record<ReminderSubjectKind, PairedEscalation>> = {
  application: {
    managerKind: "application_manager",
    description: "Also alerts you when an application sits unfinished, on its own schedule.",
  },
  lease: {
    managerKind: "lease_manager",
    description: "Also alerts you when a lease needs your attention, on its own schedule.",
  },
  inspection: {
    managerKind: "inspection_manager",
    description: "Also alerts you when move-in or move-out photos are still missing, on its own schedule.",
  },
};

/** The manager-alert half of every pair — never rendered as its own top-level row. */
const ABSORBED_KINDS = new Set(
  Object.values(PAIRED_ESCALATIONS).map((pair) => pair.managerKind),
);

/**
 * `payment_manager` is real and configurable here, but it cannot send today:
 * nothing calls the sweep that would create one of these alerts. This says so
 * plainly rather than hiding the control or pretending it works — see the
 * task's own brief and `src/lib/reminders/subjects/payments.server.ts`.
 */
const PAYMENT_MANAGER_CAVEAT =
  "This alert isn't live yet — it's configured here, but nothing currently triggers it, so turning it on won't send anything today.";

/** Multi-select dropdown. Closes on outside click and on Escape. */
function TimingMultiSelect({
  value,
  onChange,
  directions,
  dataAttr,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  directions: TimingDirection[];
  dataAttr: string;
  disabled?: boolean;
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
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        data-attr={`${dataAttr}-trigger`}
        className={`flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-border bg-transparent px-3 py-2 text-left text-[13px] text-foreground ${
          disabled ? "cursor-not-allowed opacity-60" : ""
        }`}
      >
        <span className="min-w-0 truncate">{summarizeTimings(value)}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </button>
      {open && !disabled ? (
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

/**
 * Timing picker + fixed-field notice for one kind, shown only while its rule
 * is enabled. Shared between a primary row and a nested "Also alert you"
 * sub-row so both get the same fixed-field handling for free.
 */
function ReminderTimingBlock({
  kind,
  rule,
  onChange,
}: {
  kind: ReminderSubjectKind;
  rule: ReminderRule;
  onChange: (next: ReminderRule) => void;
}) {
  if (!rule.enabled) return null;
  // `leadMinutes` predates directions; render legacy values as "before" so an
  // existing selection still shows rather than reading as empty.
  const selected = rule.timings ?? rule.leadMinutes.map((m) => timingKey({ direction: "before", minutes: m }));
  // A kind can declare fields the dispatcher hardcodes (currently only
  // `tour_interest`'s timing) — this row is read-only for those fields rather
  // than showing a control that would silently revert on the next load. See
  // `fixed-rule-fields.ts`.
  const fixed = fixedRuleFields(kind);
  const timingsFixed = fixed?.fields.includes("timings") ?? false;
  return (
    <div className="mt-2">
      <TimingMultiSelect
        value={selected}
        directions={SUBJECT_DIRECTIONS[kind]}
        dataAttr={`settings-timings-${kind}`}
        disabled={timingsFixed}
        onChange={(timings) => onChange({ ...rule, timings })}
      />
      {timingsFixed && fixed ? (
        <p className="mt-2 text-xs text-muted" data-attr={`settings-fixed-reason-${kind}`}>
          {fixed.reason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One row in the event matrix. A kind with a paired manager-alert twin (see
 * `PAIRED_ESCALATIONS`) renders as ONE row: the counterparty event on top,
 * the escalation sentence as its second line, and the manager-alert half
 * folded into an inset "Also alert you" sub-control inside the SAME row —
 * never a second sibling row.
 */
function ReminderKindRow({
  kind,
  settings,
  onUpdateKind,
}: {
  kind: ReminderSubjectKind;
  settings: ReminderSettings;
  onUpdateKind: (kind: ReminderSubjectKind, next: ReminderRule) => void;
}) {
  const rule = settings.rules[kind];
  const pair = PAIRED_ESCALATIONS[kind];
  const managerRule = pair ? settings.rules[pair.managerKind] : null;
  const isPaymentManager = kind === "payment_manager";
  const label = rowLabel(kind);

  return (
    <div className="border-b border-border px-4 py-3.5 last:border-0" data-attr={`settings-row-${kind}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[13.5px] font-semibold text-foreground">{label}</p>
            <PortalSettingsScopeTag variant="muted">
              {REMINDER_SUBJECT_META[kind].counterpartyLabel}
            </PortalSettingsScopeTag>
          </div>
          {pair ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{pair.description}</p> : null}
          {isPaymentManager ? (
            <p
              className="mt-0.5 text-[11px] leading-relaxed text-muted/70"
              data-attr="settings-row-payment_manager-caveat"
            >
              {PAYMENT_MANAGER_CAVEAT}
            </p>
          ) : null}
        </div>
        <PortalSettingsToggle
          checked={rule.enabled}
          onChange={(enabled) => onUpdateKind(kind, { ...rule, enabled })}
          label={`${label} reminders`}
          dataAttr={`settings-toggle-${kind}`}
        />
      </div>

      <ReminderTimingBlock kind={kind} rule={rule} onChange={(next) => onUpdateKind(kind, next)} />

      {pair && managerRule ? (
        // Nested INSIDE the primary kind's row — deliberately not
        // `settings-row-${pair.managerKind}`. The manager-alert half of a
        // pair never gets its own top-level row; this data-attr names it as
        // what it is, an escalation control folded into the one row above.
        <div
          className="mt-3 rounded-xl border border-border/70 bg-accent/20 px-3 py-2.5"
          data-attr={`settings-escalation-${pair.managerKind}`}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12.5px] font-medium text-foreground">Also alert you</p>
            <PortalSettingsToggle
              checked={managerRule.enabled}
              onChange={(enabled) => onUpdateKind(pair.managerKind, { ...managerRule, enabled })}
              label="Also alert you"
              dataAttr={`settings-toggle-${pair.managerKind}`}
            />
          </div>
          <ReminderTimingBlock
            kind={pair.managerKind}
            rule={managerRule}
            onChange={(next) => onUpdateKind(pair.managerKind, next)}
          />
        </div>
      ) : null}
    </div>
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

  const updateKind = useCallback((kind: ReminderSubjectKind, next: ReminderRule) => {
    setSettings((current) => ({ ...current, rules: { ...current.rules, [kind]: next } }));
  }, []);

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
      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
        <ManagerNotificationRoutingSetting />

        <PortalSettingsSection
          title="Quiet hours"
        >
          <PortalSettingsGroup>
            <PortalSettingsRow
              label="Delay overnight reminders"
            >
              <PortalSettingsToggle
                checked={settings.quietHours.enabled}
                onChange={(enabled) =>
                  setSettings((c) => ({ ...c, quietHours: { ...c.quietHours, enabled } }))
                }
                label="Quiet hours"
                dataAttr="settings-toggle-quiet-hours"
              />
            </PortalSettingsRow>
            {settings.quietHours.enabled ? (
              <div
                className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted"
                data-attr="settings-row-quiet-hours-range"
              >
                <label className="flex items-center gap-2">
                  From
                  <FieldSingleSelect
                    variant="cell"
                    hideLabel
                    label="Quiet hours start"
                    value={String(settings.quietHours.startHour)}
                    onChange={(next) =>
                      setSettings((c) => ({
                        ...c,
                        quietHours: { ...c.quietHours, startHour: Number(next) },
                      }))
                    }
                    options={QUIET_HOUR_OPTIONS}
                    wrapperClassName="w-24"
                  />
                </label>
                <label className="flex items-center gap-2">
                  until
                  <FieldSingleSelect
                    variant="cell"
                    hideLabel
                    label="Quiet hours end"
                    value={String(settings.quietHours.endHour)}
                    onChange={(next) =>
                      setSettings((c) => ({
                        ...c,
                        quietHours: { ...c.quietHours, endHour: Number(next) },
                      }))
                    }
                    options={QUIET_HOUR_OPTIONS}
                    wrapperClassName="w-24"
                  />
                </label>
                <span className="text-muted">({formatMinutes(60)} blocks, Pacific time)</span>
              </div>
            ) : null}
          </PortalSettingsGroup>
        </PortalSettingsSection>

        <PortalSettingsSection
          title="Reminders by area"
        >
          <div className="space-y-5">
            {MODULE_ORDER.map((moduleId) => {
              const kinds = REMINDER_SUBJECT_KINDS.filter(
                (kind) => REMINDER_KIND_MODULE[kind] === moduleId && !ABSORBED_KINDS.has(kind),
              );
              if (kinds.length === 0) return null;
              return (
                <div key={moduleId} data-attr={`settings-module-${moduleId}`}>
                  <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-muted/80">
                    {MODULE_LABEL[moduleId] ?? moduleId}
                  </h3>
                  <PortalSettingsGroup>
                    {kinds.map((kind) => (
                      <ReminderKindRow key={kind} kind={kind} settings={settings} onUpdateKind={updateKind} />
                    ))}
                  </PortalSettingsGroup>
                </div>
              );
            })}
          </div>
        </PortalSettingsSection>

        <PortalSettingsSection title="Sent history">
          <ReminderSentHistory />
        </PortalSettingsSection>
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
