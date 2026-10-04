"use client";

import { useEffect, useMemo, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import { assigneeIsStale, assignmentCandidatesFor, type WorkAssignee } from "@/lib/work-assignment";

/**
 * The Assign popup of a task page (Assign icon in the header): the same assignee picker the task
 * form's Assignee field uses, in the standard popup frame. A teammate or a vendor can take a task.
 */
export function TaskAssignDialog({
  open,
  onClose,
  current,
  teamMembers,
  vendors,
  onAssign,
}: {
  open: boolean;
  onClose: () => void;
  current: WorkAssignee | null;
  teamMembers: ReadonlyArray<{ userId: string; name?: string | null; email?: string | null }>;
  vendors: ReadonlyArray<{ id: string; name?: string | null; trade?: string | null; active?: boolean }>;
  onAssign: (assignee: WorkAssignee | null) => void | Promise<void>;
}) {
  // Someone who is no longer on the team is not a choice the picker can show, so the dialog starts on
  // Unassigned and the button names only what the field shows - never a person the field does not.
  const candidates = useMemo(
    () => assignmentCandidatesFor("task", { teamMembers, vendors }),
    [teamMembers, vendors],
  );
  const start = current && !assigneeIsStale(current, candidates) ? current : null;
  const [value, setValue] = useState<WorkAssignee | null>(start);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setValue(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when the dialog opens or the task's assignee changes
  }, [open, start?.id, start?.type]);

  const unchanged = (value?.id ?? "") === (start?.id ?? "") && (value?.type ?? "") === (start?.type ?? "");
  const assignedNow = Boolean(current);

  const submit = async () => {
    setBusy(true);
    try {
      await onAssign(value);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalDialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissBlocked={busy}
      title="Assign"
      primaryAction={{
        label: value ? `Assign ${value.name?.trim() || "task"}` : assignedNow && start ? "Unassign" : "Assign",
        onClick: () => void submit(),
        disabled: unchanged || busy,
        loading: busy,
        dataAttr: "task-assign-submit",
      }}
    >
      <div data-attr="task-assign-dialog">
        <WorkAssignmentPicker
          kind="task"
          value={value}
          teamMembers={teamMembers}
          vendors={vendors}
          label="Assign to"
          dataAttr="task-assign-picker"
          onChange={setValue}
        />
      </div>
    </PortalDialog>
  );
}
