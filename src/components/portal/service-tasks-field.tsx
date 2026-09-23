"use client";

import { CheckboxOption } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import type { WorkAssignee } from "@/lib/work-assignment";

/**
 * Manager Add service — a checkbox, not a title list. Checked reveals one
 * Assignee picker (`kind=task`, team + vendors). Title, property, room and
 * notes come from the service.
 */
export function ServiceTasksField({
  enabled,
  onEnabledChange,
  assignee,
  onAssigneeChange,
  teamMembers,
  vendors,
  disabled = false,
  dataAttr = "service-tasks",
}: {
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  assignee: WorkAssignee | null;
  onAssigneeChange: (next: WorkAssignee | null) => void;
  teamMembers: readonly { userId: string; name?: string | null; email?: string | null }[];
  vendors: readonly { id: string; name?: string | null; trade?: string | null; active?: boolean }[];
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <div>
      <CheckboxOption
        label="Add task"
        checked={enabled}
        onChange={(next) => {
          onEnabledChange(next);
          if (!next) onAssigneeChange(null);
        }}
        dataAttr={`${dataAttr}-toggle`}
      />
      {enabled ? (
        <div className="mt-1">
          <WorkAssignmentPicker
            kind="task"
            label="Assignee"
            value={assignee}
            teamMembers={teamMembers}
            vendors={vendors}
            disabled={disabled}
            onChange={onAssigneeChange}
            dataAttr={`${dataAttr}-assignee`}
          />
        </div>
      ) : null}
    </div>
  );
}
