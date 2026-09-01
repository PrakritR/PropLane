"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { REMINDER_FIELD_LABEL_CLASS } from "@/components/portal/reminder-settings-shared";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";
import {
  DEFAULT_LIFECYCLE_AUTOMATION,
  describeLifecycleRule,
  formatOffset,
  formatTaskReminderTimingLabel,
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

function sectionSelectLabel(section: LifecycleSection): string {
  return `Tasks for ${LIFECYCLE_SECTION_LABELS[section]}`;
}

function offsetSelectOptions() {
  return OFFSET_PRESETS.map((minutes) => ({
    value: String(minutes),
    label: formatOffset(minutes),
  }));
}

function reminderSelectOptions(selected: number[]) {
  const presetOptions = TASK_REMINDER_TIMING_PRESETS.map((minutes) => ({
    value: String(minutes),
    label: formatTaskReminderTimingLabel(minutes),
  }));
  const customOptions = selected
    .filter(
      (minutes) =>
        !TASK_REMINDER_TIMING_PRESETS.includes(minutes as (typeof TASK_REMINDER_TIMING_PRESETS)[number]),
    )
    .map((minutes) => ({
      value: String(minutes),
      label: formatTaskReminderTimingLabel(minutes),
    }));
  return [...customOptions, ...presetOptions];
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
  const [customReminderMinutes, setCustomReminderMinutes] = useState("");

  const sectionOptions = useMemo(
    () =>
      LIFECYCLE_SECTIONS.map((id) => ({
        value: id,
        label: sectionSelectLabel(id),
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
      <FieldSingleSelect
        label="Category"
        value={section}
        options={sectionOptions}
        onChange={(value) => {
          if (LIFECYCLE_SECTIONS.includes(value as LifecycleSection)) setSection(value as LifecycleSection);
        }}
        disabled={loading || saving}
        dataAttr="task-automation-section"
      />

      {keys.map((key) => {
        const config = automation[key];
        const meta = LIFECYCLE_TASK_META[key];
        const reminderSorted = normalizeTaskReminderMinutesBeforeList(config.reminderMinutesBeforeList, []);
        const reminderTokens = reminderSorted.map(String);
        const reminderTriggerLabel = reminderSorted.length
          ? reminderSorted.map((m) => formatReminderTriggerLabel(m)).join(", ")
          : undefined;

        return (
          <div key={key} className="space-y-3 rounded-xl border border-border p-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={config.enabled}
                disabled={loading || saving}
                data-attr={`task-automation-${key}-enabled`}
                onChange={(e) => patchTask(key, { enabled: e.target.checked })}
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">{meta.label}</span>
                <span className="block text-xs text-muted">{describeLifecycleRule(key, config)}</span>
              </span>
            </label>

            {config.enabled ? (
              <>
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
                  <label className="space-y-1 text-sm">
                    <span className="font-medium text-foreground">Assign to</span>
                    <Select
                      value={config.defaultAssigneeUserId ?? ""}
                      disabled={loading || saving}
                      data-attr={`task-automation-${key}-assignee`}
                      onChange={(e) =>
                        patchTask(key, {
                          defaultAssigneeUserId: e.target.value.trim() || null,
                        })
                      }
                    >
                      <option value="">Property manager (you)</option>
                      {teamMembers.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.name?.trim() || member.email?.trim() || member.userId}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>

                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    checked={config.sendEmailReminder}
                    disabled={loading || saving}
                    data-attr={`task-automation-${key}-reminder`}
                    onChange={(e) => patchTask(key, { sendEmailReminder: e.target.checked })}
                  />
                  <span className="text-xs text-muted">
                    Email the assignee when the task is created and again on the due date.
                  </span>
                </label>

                <div className="space-y-2">
                  <CheckboxMultiSelect
                    label="Remind before due"
                    labelClassName={REMINDER_FIELD_LABEL_CLASS}
                    options={reminderSelectOptions(reminderSorted)}
                    selected={reminderTokens}
                    selectionTriggerLabel={reminderTriggerLabel}
                    onChange={(tokens) =>
                      patchTask(key, {
                        reminderMinutesBeforeList: normalizeTaskReminderMinutesBeforeList(
                          tokens.map((t) => Number(t)),
                          [],
                        ),
                      })
                    }
                    disabled={loading || saving}
                    emptyLabel="Choose reminder times…"
                    dataAttr={`task-automation-${key}-reminder-before`}
                    menuFooter={
                      <div className="px-3 py-2">
                        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
                          Custom minutes
                        </p>
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            min={5}
                            max={1440}
                            className="h-9 min-h-0 flex-1"
                            placeholder="Minutes before due"
                            value={customReminderMinutes}
                            disabled={loading || saving}
                            data-attr={`task-automation-${key}-reminder-custom`}
                            onChange={(e) => setCustomReminderMinutes(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                const minutes = Math.round(Number(customReminderMinutes.trim()));
                                if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) return;
                                patchTask(key, {
                                  reminderMinutesBeforeList: normalizeTaskReminderMinutesBeforeList(
                                    [...reminderSorted, minutes],
                                    [],
                                  ),
                                });
                                setCustomReminderMinutes("");
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            className="h-9 shrink-0 rounded-full px-3 text-xs"
                            disabled={loading || saving}
                            onClick={() => {
                              const minutes = Math.round(Number(customReminderMinutes.trim()));
                              if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) return;
                              patchTask(key, {
                                reminderMinutesBeforeList: normalizeTaskReminderMinutesBeforeList(
                                  [...reminderSorted, minutes],
                                  [],
                                ),
                              });
                              setCustomReminderMinutes("");
                            }}
                          >
                            Add
                          </Button>
                        </div>
                      </div>
                    }
                  />
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export { DEFAULT_LIFECYCLE_AUTOMATION };
