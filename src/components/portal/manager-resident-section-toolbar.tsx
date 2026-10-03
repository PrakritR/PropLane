"use client";

import type { ReactNode } from "react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import type { RecordHeaderAction } from "@/lib/portals/record-sections";

/**
 * Section header card for manager resident record tabs (studio-redesign C2-RT3).
 */
export function ManagerResidentSectionToolbar({
  actions,
  onAction,
  destinationRow,
  search,
  overflowMenu,
  className,
}: {
  actions: RecordHeaderAction[];
  onAction: (actionId: string) => void;
  destinationRow?: ReactNode;
  search?: { value: string; onChange: (next: string) => void; placeholder?: string; dataAttr?: string };
  overflowMenu?: ReactNode;
  className?: string;
}) {
  const primaryIndex = actions.findIndex((a) => a.tone === "primary");
  const primary = primaryIndex >= 0 ? actions[primaryIndex] : undefined;
  const secondary = actions.filter((_, i) => i !== primaryIndex);

  return (
    <PortalListControlStack
      className={className ?? "rs40 mb-2 max-lg:mb-1.5 plp-header-card"}
      variant="command"
      destinationRow={destinationRow}
      search={
        search
          ? {
              value: search.value,
              onChange: search.onChange,
              placeholder: search.placeholder ?? "Search",
              dataAttr: search.dataAttr,
            }
          : undefined
      }
      actions={
        <>
          {secondary.map((action) => (
            <PortalIconAction
              key={action.id}
              icon={action.icon}
              label={action.label}
              tone={action.tone}
              data-attr={`resident-section-action-${action.id}`}
              onClick={() => onAction(action.id)}
            />
          ))}
          {overflowMenu}
        </>
      }
      primary={
        primary ? (
          <PortalPrimaryIconAction
            label={primary.label}
            data-attr={`resident-section-action-${primary.id}`}
            onClick={() => onAction(primary.id)}
          />
        ) : undefined
      }
    />
  );
}
