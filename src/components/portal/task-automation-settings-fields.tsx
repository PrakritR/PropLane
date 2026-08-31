"use client";

import { Select } from "@/components/ui/input";
import {
  DEFAULT_TASK_TEMPLATE_LABELS,
  type DefaultTaskTemplateKey,
  type TaskAutomationPreferences,
  type TaskTemplateConfig,
} from "@/lib/task-automation-preferences";
import type { WorkAssignmentTeamMember } from "@/hooks/use-work-assignment-directory";
import { cn } from "@/lib/utils";

export function TaskAutomationSettingsFields({
  templateKeys,
  taskAutomation,
  teamMembers,
  loading,
  saving,
  onChange,
  withTopBorder = true,
}: {
  templateKeys: DefaultTaskTemplateKey[];
  taskAutomation: TaskAutomationPreferences;
  teamMembers: WorkAssignmentTeamMember[];
  loading: boolean;
  saving: boolean;
  onChange: (next: TaskAutomationPreferences) => void;
  withTopBorder?: boolean;
}) {
  function patchTemplate(key: DefaultTaskTemplateKey, patch: Partial<TaskTemplateConfig>) {
    onChange({
      ...taskAutomation,
      [key]: { ...taskAutomation[key], ...patch },
    });
  }

  return (
    <div className={cn("space-y-4", withTopBorder && "border-t border-border pt-4")}>
      <div>
        <p className="text-[13px] font-semibold text-foreground">Default tasks</p>
        <p className="mt-1 text-xs text-muted">
          PropLane can create tasks automatically with due dates and email reminders for your team.
        </p>
      </div>
      {templateKeys.map((key) => {
        const config = taskAutomation[key];
        return (
          <div key={key} className="space-y-3 rounded-xl border border-border p-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={config.enabled}
                disabled={loading || saving}
                data-attr={`task-automation-${key}-enabled`}
                onChange={(e) => patchTemplate(key, { enabled: e.target.checked })}
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">
                  {DEFAULT_TASK_TEMPLATE_LABELS[key]}
                </span>
                <span className="block text-xs text-muted">Create this task automatically when triggered.</span>
              </span>
            </label>
            {config.enabled ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span className="font-medium text-foreground">Due after (days)</span>
                  <input
                    type="number"
                    min={0}
                    max={90}
                    className="h-10 w-full rounded-xl border border-border bg-card px-3 text-sm"
                    value={config.daysAfterTrigger}
                    disabled={loading || saving}
                    data-attr={`task-automation-${key}-days`}
                    onChange={(e) =>
                      patchTemplate(key, {
                        daysAfterTrigger: Math.max(0, Math.min(90, Number.parseInt(e.target.value, 10) || 0)),
                      })
                    }
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium text-foreground">Assign to</span>
                  <Select
                    value={config.defaultAssigneeUserId ?? ""}
                    disabled={loading || saving}
                    data-attr={`task-automation-${key}-assignee`}
                    onChange={(e) =>
                      patchTemplate(key, {
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
            ) : null}
            {config.enabled ? (
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  checked={config.sendEmailReminder}
                  disabled={loading || saving}
                  data-attr={`task-automation-${key}-reminder`}
                  onChange={(e) => patchTemplate(key, { sendEmailReminder: e.target.checked })}
                />
                <span className="text-xs text-muted">Email the assignee when the task is created and again on the due date.</span>
              </label>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
