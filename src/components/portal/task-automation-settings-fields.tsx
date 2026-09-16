"use client";

import { useMemo, useState } from "react";
import { FieldSingleSelect, CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { CustomChipInput, REMINDER_FIELD_LABEL_CLASS } from "@/components/portal/reminder-settings-shared";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";
import {
  DEFAULT_LIFECYCLE_AUTOMATION,
  describeLifecycleRule,
  formatOffset,
  LIFECYCLE_SECTION_LABELS,
  LIFECYCLE_SECTIONS,
  LIFECYCLE_TASK_META,
  OFFSET_PRESETS,
  TASK_REMINDER_TIMING_PRESETS,
  lifecycleKeysForSection,
  normalizeTaskReminderMinutesBeforeList,
  type LifecycleSection,
  type LifecycleTaskAutomation,
  type LifecycleTaskConfig,
  type LifecycleTaskKey,
} from "@/lib/task-lifecycle-automation";

function offsetSelectOptions() {
  return OFFSET_PRESETS.map((minutes) => ({
    value: String(minutes),
    label: formatOffset(minutes),
  }));
}

/** Presets plus any stored custom minutes, shortest first, as chip options. */
function reminderChipOptions(selected: number[]) {
  const presets = new Set<number>(TASK_REMINDER_TIMING_PRESETS);
  return [...new Set([...selected, ...TASK_REMINDER_TIMING_PRESETS])]
    .sort((a, b) => a - b)
    .map((minutes) => ({
      value: String(minutes),
      label: formatReminderTriggerLabel(minutes),
      title: presets.has(minutes) ? undefined : "Custom time — turn off to remove",
    }));
}

function formatReminderTriggerLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hr`;
  return `${hours}h ${remainder}m`;
}

export function TaskAutomationSettingsFields({
  automation,
  teamMembers,
  loading,
  saving,
  onChange,
}: {
  automation: LifecycleTaskAutomation;
  teamMembers: WorkAssignmentTeamMember[];
  loading: boolean;
  saving: boolean;
  onChange: (next: LifecycleTaskAutomation) => void;
}) {
  const [section, setSection] = useState<LifecycleSection>("applications");
  const [customOpenFor, setCustomOpenFor] = useState<LifecycleTaskKey | null>(null);

  const sectionOptions = useMemo(
    () =>
      LIFECYCLE_SECTIONS.map((id) => ({
        value: id,
        label: LIFECYCLE_SECTION_LABELS[id],
      })),
    [],
  );

  const keys = lifecycleKeysForSection(section);

  function patchTask(key: LifecycleTaskKey, patch: Partial<LifecycleTaskConfig>) {
    onChange({
      ...automation,
      [key]: { ...automation[key], ...patch },
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldSingleSelect
          label="Tasks for"
          labelClassName={REMINDER_FIELD_LABEL_CLASS}
          value={section}
          options={sectionOptions}
          onChange={(value) => {
            if (LIFECYCLE_SECTIONS.includes(value as LifecycleSection)) setSection(value as LifecycleSection);
          }}
          disabled={loading || saving}
          dataAttr="task-automation-section"
        />
      </div>

      {keys.map((key) => {
        const config = automation[key];
        const meta = LIFECYCLE_TASK_META[key];
        const reminderSorted = normalizeTaskReminderMinutesBeforeList(config.reminderMinutesBeforeList, []);
        const reminderTokens = reminderSorted.map(String);
        const commitReminderMinutes = (minutes: number[]) =>
          patchTask(key, { reminderMinutesBeforeList: normalizeTaskReminderMinutesBeforeList(minutes, []) });

        return (
          <div key={key} className="space-y-3 rounded-xl border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">{meta.label}</span>
                <span className="block text-xs text-muted">{describeLifecycleRule(key, config)}</span>
              </span>
              <PortalSettingsToggle
                checked={config.enabled}
                onChange={(next) => patchTask(key, { enabled: next })}
                label={meta.label}
                disabled={loading || saving}
                dataAttr={`task-automation-${key}-enabled`}
              />
            </div>

            {config.enabled ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <FieldSingleSelect
                  label={meta.anchor === "before_event" ? "Due before event" : "Due after trigger"}
                  value={String(config.offsetMinutes)}
                  options={offsetSelectOptions()}
                  onChange={(value) => {
                    const minutes = Number.parseInt(value, 10);
                    if (Number.isFinite(minutes)) patchTask(key, { offsetMinutes: minutes });
                  }}
                  disabled={loading || saving}
                  dataAttr={`task-automation-${key}-offset`}
                />
                <FieldSingleSelect
                  label="Assign to"
                  value={config.defaultAssigneeUserId ?? ""}
                  options={[
                    { value: "", label: "Property manager (you)" },
                    ...teamMembers.map((member) => ({
                      value: member.userId,
                      label: member.name?.trim() || member.email?.trim() || member.userId,
                    })),
                  ]}
                  onChange={(value) =>
                    patchTask(key, {
                      defaultAssigneeUserId: value.trim() || null,
                    })
                  }
                  disabled={loading || saving}
                  dataAttr={`task-automation-${key}-assignee`}
                />

                <div className="flex items-start justify-between gap-3 sm:col-span-2">
                  <span className="text-xs text-muted">
                    Email the assignee when the task is created and again on the due date.
                  </span>
                  <PortalSettingsToggle
                    checked={config.sendEmailReminder}
                    onChange={(next) => patchTask(key, { sendEmailReminder: next })}
                    label="Email the assignee when the task is created and again on the due date."
                    disabled={loading || saving}
                    dataAttr={`task-automation-${key}-reminder`}
                  />
                </div>

                <div className="sm:col-span-2">
                  <CheckboxMultiSelect
                    label="Remind before due"
                    labelClassName={REMINDER_FIELD_LABEL_CLASS}
                    options={reminderChipOptions(reminderSorted)}
                    selected={reminderTokens}
                    onChange={(tokens) => commitReminderMinutes(tokens.map((t) => Number(t)))}
                    disabled={loading || saving}
                    emptyLabel="None selected"
                    dataAttr={`task-automation-${key}-reminder-before`}
                    menuFooter={
                      <div className="border-t border-border p-2">
                        <CustomChipInput
                          open={customOpenFor === key}
                          onOpen={() => setCustomOpenFor(key)}
                          onClose={() => setCustomOpenFor(null)}
                          onCommit={(minutes) => {
                            commitReminderMinutes([...reminderSorted, minutes]);
                            return true;
                          }}
                          unit="min"
                          min={5}
                          max={1440}
                          disabled={loading || saving}
                          dataAttr={`task-automation-${key}-reminder-custom`}
                          placeholder="Custom minutes before due"
                        />
                      </div>
                    }
                  />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export { DEFAULT_LIFECYCLE_AUTOMATION };
