"use client";

import { useEffect, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import type { WorkAssignee } from "@/lib/work-assignment";

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
  const [value, setValue] = useState<WorkAssignee | null>(current);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setValue(current);
  }, [open, current]);

  const unchanged = (value?.id ?? "") === (current?.id ?? "") && (value?.type ?? "") === (current?.type ?? "");

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
        label: value ? `Assign ${value.name?.trim() || "task"}` : "Unassign",
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
