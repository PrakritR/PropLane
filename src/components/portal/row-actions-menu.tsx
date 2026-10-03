"use client";

import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";

export type RowAction = { id: string; label: string; onSelect: () => void; danger?: boolean; disabled?: boolean };

/** A row ⋯ built on the shared record-action menu: actions in order, a red one last. */
export function RowActionsMenu({ label, items }: { label: string; items: readonly (RowAction | null | false | undefined)[] }) {
  const actions = items.filter((item): item is RowAction => Boolean(item));
  return (
    <RecordActionContext.Provider
      value={{
        scope: label,
        clear: () => {},
        actions: (
          <>
            {actions.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant={item.danger ? "danger" : "outline"}
                data-record-action-id={item.danger ? "delete" : item.id}
                disabled={item.disabled}
                onClick={item.onSelect}
              >
                {item.label}
              </Button>
            ))}
          </>
        ),
      }}
    >
      <RecordActionMenu label={label} activate={() => {}} />
    </RecordActionContext.Provider>
  );
}
