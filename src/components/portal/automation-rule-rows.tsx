"use client";

/**
 * Compact reminder rules — one row each (PLAN-0915).
 *
 * The full `ManagerReminderRuleSettingsPanel` is right for a subject with
 * several timings and three audiences. An escalation ("tell me when a request
 * has sat unassigned for 24 hours") is one switch and one number, and a tab
 * with eight of them cannot afford eight full panels. This renders the rules
 * it is given as rows on the settings kit — label, timing picker, toggle, and
 * a Template pen — loading the manager's rules once and saving each kind
 * through the same `/api/portal/reminder-settings` PATCH the full panel uses,
 * so there is exactly one store and one normaliser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_REMINDER_RULES,
  REMINDER_SUBJECT_META,
  normalizeReminderSettings,
  type ReminderRule,
  type ReminderSubjectKind,
} from "@/lib/reminders/rules";
import { timingOptions } from "@/lib/reminders/timings";
import { fillReminderTemplate, reminderSubjectSettingsMeta } from "@/lib/reminders/subject-settings-meta";
import { ReminderMessageUpdateModal } from "@/components/portal/reminder-settings-shared";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";

export type AutomationRuleRowSpec = {
  kind: ReminderSubjectKind;
  /** Overrides `REMINDER_SUBJECT_META[kind].label` when the tab wants a different verb. */
  label?: string;
  /** Show the Template pen. Default on. */
  template?: boolean;
  /** Single-timing picker. Default on; off to hide timing entirely. */
  timing?: boolean;
  /** Several timings at once ("90, 60, 30 days before") as one multi-select. */
  multi?: boolean;
};

export function AutomationRuleRows({ rows, disabled: disabledProp }: { rows: AutomationRuleRowSpec[]; disabled?: boolean }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<Partial<Record<ReminderSubjectKind, ReminderRule>>>({});
  const [editing, setEditing] = useState<ReminderSubjectKind | null>(null);
  const pending = useRef<Map<ReminderSubjectKind, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (demo) {
          if (!cancelled) setRules({ ...DEFAULT_REMINDER_RULES });
          return;
        }
        const res = await fetch("/api/portal/reminder-settings", { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not load reminder settings.");
        if (!cancelled) setRules(normalizeReminderSettings(body.settings).rules);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not load reminder settings.");
        if (!cancelled) setRules({ ...DEFAULT_REMINDER_RULES });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, showToast]);

  const save = useCallback(
    async (kind: ReminderSubjectKind, rule: ReminderRule) => {
      if (demo) return;
      reportSaveStatus({ type: "start" });
      try {
        const res = await fetch("/api/portal/reminder-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, rule }),
          keepalive: true,
        });
        const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not save reminder settings.");
        const saved = normalizeReminderSettings(body.settings).rules[kind];
        setRules((current) => ({ ...current, [kind]: saved }));
        reportSaveStatus({ type: "success" });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not save reminder settings.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
      }
    },
    [demo, reportSaveStatus, showToast],
  );

  const patch = useCallback(
    (kind: ReminderSubjectKind, next: Partial<ReminderRule>) => {
      setRules((current) => {
        const merged = { ...(current[kind] ?? DEFAULT_REMINDER_RULES[kind]), ...next };
        const timer = pending.current.get(kind);
        if (timer) clearTimeout(timer);
        pending.current.set(
          kind,
          setTimeout(() => void save(kind, merged), 500),
        );
        return { ...current, [kind]: merged };
      });
    },
    [save],
  );

  const disabled = disabledProp || loading;
  const editingMeta = useMemo(() => (editing ? reminderSubjectSettingsMeta(editing) : null), [editing]);
  const editingRule = editing ? rules[editing] ?? DEFAULT_REMINDER_RULES[editing] : null;

  return (
    <>
      <PortalSettingsGroup>
        {rows.map((spec) => {
          const rule = rules[spec.kind] ?? DEFAULT_REMINDER_RULES[spec.kind];
          const meta = reminderSubjectSettingsMeta(spec.kind);
          const directions = meta?.directions ?? ["after"];
          const options = timingOptions(directions);
          const timing = rule.timings?.[0] ?? "";
          const label = spec.label ?? REMINDER_SUBJECT_META[spec.kind].label;
          return (
            <PortalSettingsRow key={spec.kind} label={label} className="flex-wrap gap-y-2.5">
              <div className="flex flex-wrap items-center justify-end gap-2">
                {spec.multi && rule.enabled ? (
                  <CheckboxMultiSelect
                    label={meta?.timingLabel ?? "Timing"}
                    hideLabel
                    variant="cell"
                    className="w-52"
                    options={options}
                    selected={rule.timings ?? []}
                    onChange={(next) => patch(spec.kind, { timings: next.length ? next : rule.timings })}
                    disabled={disabled}
                    dataAttr={`automation-rule-${spec.kind}-timings`}
                  />
                ) : spec.timing !== false && rule.enabled ? (
                  <FieldSingleSelect
                    label={meta?.timingLabel ?? "Timing"}
                    hideLabel
                    variant="cell"
                    wrapperClassName="w-44"
                    options={options.some((option) => option.value === timing) || !timing ? options : [{ value: timing, label: timing }, ...options]}
                    value={timing}
                    onChange={(next) => patch(spec.kind, { timings: [next] })}
                    disabled={disabled}
                    dataAttr={`automation-rule-${spec.kind}-timing`}
                  />
                ) : null}
                {spec.template !== false && meta ? (
                  <button
                    type="button"
                    className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-primary"
                    disabled={disabled}
                    data-attr={`automation-rule-${spec.kind}-template`}
                    onClick={() => setEditing(spec.kind)}
                  >
                    Template
                  </button>
                ) : null}
                <PortalSettingsToggle
                  checked={rule.enabled}
                  onChange={(next) => patch(spec.kind, { enabled: next })}
                  label={label}
                  disabled={disabled}
                  dataAttr={`automation-rule-${spec.kind}-enabled`}
                />
              </div>
            </PortalSettingsRow>
          );
        })}
      </PortalSettingsGroup>
      {editing && editingMeta && editingRule ? (
        <ReminderMessageUpdateModal
          open
          onClose={() => setEditing(null)}
          subject={editingRule.template?.subject ?? editingMeta.defaultTemplate.subject}
          body={editingRule.template?.body ?? editingMeta.defaultTemplate.body}
          recipient={editingMeta.recipientPreview}
          viaInbox={editingRule.inbox}
          viaEmail={editingRule.email}
          viaSms={editingRule.sms}
          placeholders={`${editingMeta.placeholders}\n\nPreview: ${fillReminderTemplate(editingRule.template ?? editingMeta.defaultTemplate, editingMeta.previewContext).subject}`}
          onSave={({ subject, body, viaInbox, viaEmail, viaSms }) => {
            patch(editing, { template: { subject, body }, inbox: viaInbox, email: viaEmail, sms: viaSms });
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}
