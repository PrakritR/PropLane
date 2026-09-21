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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  useSettingsPropertyScope,
  type SettingsResolutionSource,
} from "@/components/portal/settings-property-scope";
import {
  DEFAULT_REMINDER_RULES,
  REMINDER_SUBJECT_META,
  VENDOR_AUDIENCE_KINDS,
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
  // Workspace + per-property scope (PLAN-0916-1040 / PLAN-0920-0845 phase D); the
  // no-op account scope outside a provider.
  const {
    propertyId: scopePropertyId,
    propertyIds: scopePropertyIds,
    workspaceId: scopeWorkspaceId,
    reportOverriddenPropertyIds,
    reportSource,
    resetSignal,
  } = useSettingsPropertyScope();
  const scopeKey = `automation-rules:${useId()}`;
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<Partial<Record<ReminderSubjectKind, ReminderRule>>>({});
  const [editing, setEditing] = useState<ReminderSubjectKind | null>(null);
  const pending = useRef<Map<ReminderSubjectKind, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        if (demo) {
          if (!cancelled) setRules({ ...DEFAULT_REMINDER_RULES });
          return;
        }
        const params = new URLSearchParams();
        if (scopePropertyId) params.set("propertyId", scopePropertyId);
        if (scopeWorkspaceId) params.set("workspaceId", scopeWorkspaceId);
        const query = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`/api/portal/reminder-settings${query}`, { credentials: "include", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as {
          settings?: unknown;
          error?: string;
          overriddenPropertyIds?: string[];
          source?: SettingsResolutionSource;
        };
        if (!res.ok) throw new Error(body.error ?? "Could not load reminder settings.");
        if (!cancelled) {
          setRules(normalizeReminderSettings(body.settings).rules);
          reportOverriddenPropertyIds(scopeKey, body.overriddenPropertyIds ?? []);
          reportSource("reminder-settings", body.source);
        }
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
  }, [demo, showToast, scopePropertyId, scopeWorkspaceId, scopeKey, reportOverriddenPropertyIds, reportSource]);

  // Reset the selected house(s)' reminder override on the scope bar's request. Fire
  // only when the signal advances past the mount value (StrictMode double-invokes
  // mount). Loops every selected house so a multi-property Reset clears all of them,
  // not just the first.
  const lastResetRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === lastResetRef.current) return;
    lastResetRef.current = resetSignal;
    const targets = scopePropertyIds.length > 0 ? scopePropertyIds : scopePropertyId ? [scopePropertyId] : [];
    if (targets.length === 0 || demo) return;
    let cancelled = false;
    void (async () => {
      try {
        let last: { settings?: unknown; overriddenPropertyIds?: string[] } | null = null;
        for (const target of targets) {
          const res = await fetch("/api/portal/reminder-settings", {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ propertyId: target, reset: true }),
          });
          const body = (await res.json().catch(() => ({}))) as { settings?: unknown; error?: string; overriddenPropertyIds?: string[] };
          if (!res.ok) throw new Error(body.error ?? "Could not reset reminder settings.");
          last = body;
        }
        if (!cancelled && last) {
          setRules(normalizeReminderSettings(last.settings).rules);
          reportOverriddenPropertyIds(scopeKey, last.overriddenPropertyIds ?? []);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not reset reminder settings.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const save = useCallback(
    async (kind: ReminderSubjectKind, rule: ReminderRule) => {
      if (demo) return;
      reportSaveStatus({ type: "start" });
      try {
        const res = await fetch("/api/portal/reminder-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            rule,
            ...(scopePropertyId ? { propertyId: scopePropertyId } : {}),
            ...(scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : {}),
          }),
          keepalive: true,
        });
        const body = (await res.json().catch(() => ({}))) as {
          settings?: unknown;
          error?: string;
          overriddenPropertyIds?: string[];
          source?: SettingsResolutionSource;
        };
        if (!res.ok) throw new Error(body.error ?? "Could not save reminder settings.");
        const saved = normalizeReminderSettings(body.settings).rules[kind];
        setRules((current) => ({ ...current, [kind]: saved }));
        reportOverriddenPropertyIds(scopeKey, body.overriddenPropertyIds ?? []);
        reportSource("reminder-settings", body.source);
        reportSaveStatus({ type: "success" });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not save reminder settings.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
      }
    },
    [demo, reportSaveStatus, showToast, scopePropertyId, scopeWorkspaceId, scopeKey, reportOverriddenPropertyIds, reportSource],
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
          const timingCount = (rule.timings ?? []).filter(Boolean).length;
          const label = spec.label ?? REMINDER_SUBJECT_META[spec.kind].label;
          const rowLabel = timingCount > 1 ? `${label} (${timingCount})` : label;
          const counterpartLabel = meta?.notifyCounterpartyLabel ?? "Resident";
          const whoOptions = [
            { value: "manager", label: "You" },
            { value: "team", label: "Team" },
            { value: "assignee", label: "Assignee" },
            ...(counterpartLabel.toLowerCase() === "assignee"
              ? []
              : [{ value: "counterparty", label: counterpartLabel }]),
            ...(VENDOR_AUDIENCE_KINDS.has(spec.kind) ? [{ value: "vendor", label: "Vendor" }] : []),
          ];
          const whoValue = [
            ...(rule.audience.manager ? ["manager"] : []),
            ...(rule.audience.team ? ["team"] : []),
            ...(rule.audience.counterparty ? ["assignee"] : []),
            ...(rule.audience.counterparty && counterpartLabel.toLowerCase() !== "assignee" ? ["counterparty"] : []),
            ...(rule.audience.vendor ? ["vendor"] : []),
          ];
          return (
            <PortalSettingsRow key={spec.kind} label={rowLabel} className="flex-wrap gap-y-2.5">
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
                {rule.enabled ? (
                  <CheckboxMultiSelect
                    label="Who"
                    hideLabel
                    variant="cell"
                    className="w-40"
                    options={whoOptions}
                    selected={whoValue}
                    onChange={(next) =>
                      patch(spec.kind, {
                        audience: {
                          ...rule.audience,
                          manager: next.includes("manager"),
                          team: next.includes("team"),
                          counterparty: next.includes("assignee") || next.includes("counterparty"),
                          vendor: next.includes("vendor"),
                        },
                      })
                    }
                    disabled={disabled}
                    emptyLabel="Who"
                    dataAttr={`automation-rule-${spec.kind}-who`}
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
