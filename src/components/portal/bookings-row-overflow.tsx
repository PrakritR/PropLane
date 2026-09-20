"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";

/** Bookings row ⋯ — Edit + Delete. Never a View item (RecordActionMenu adds that when `onOpen` is set). */
export function BookingsRowOverflow({
  label,
  onEdit,
  onDelete,
  children,
}: {
  label: string;
  onEdit: () => void;
  onDelete?: () => void;
  /** When set, this provides the ⋯ context for a list row (one menu). Otherwise it draws its own ⋯. */
  children?: ReactNode;
}) {
  return (
    <RecordActionContext.Provider
      value={{
        scope: label,
        clear: () => {},
        actions: (
          <>
            <Button type="button" variant="outline" data-attr="bookings-row-edit" onClick={onEdit}>
              Edit
            </Button>
            {onDelete ? (
              <Button type="button" variant="danger" data-attr="bookings-row-delete" onClick={onDelete}>
                Delete
              </Button>
            ) : null}
          </>
        ),
      }}
    >
      {children ?? <RecordActionMenu label={label} activate={() => {}} />}
    </RecordActionContext.Provider>
  );
}
