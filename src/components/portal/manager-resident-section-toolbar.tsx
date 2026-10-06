"use client";

import type { ReactNode } from "react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import type { RecordHeaderAction } from "@/lib/portals/record-sections";

/**
 * Section header card for manager resident record tabs (studio-redesign C2-RT3).
 */
export function ManagerResidentSectionToolbar({
  title,
  actions,
  onAction,
  destinationRow,
  search,
  overflowMenu,
  className,
}: {
  /** The section's name, on the left of the header card (every resident record tab carries one). */
  title?: string;
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
  const headerRow =
    title || destinationRow ? (
      <div className="flex min-w-0 items-center gap-1" data-attr="resident-section-header">
        {title ? (
          <h2
            className="shrink-0 px-3 text-[15px] font-semibold tracking-[-0.01em] text-foreground"
            data-attr="resident-section-title"
          >
            {title}
          </h2>
        ) : null}
        {destinationRow ? <div className="min-w-0 flex-1">{destinationRow}</div> : null}
      </div>
    ) : undefined;

  return (
    <PortalListControlStack
      className={className ?? "rs40 mb-2 max-lg:mb-1.5 plp-header-card"}
      variant="command"
      destinationRow={headerRow}
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
