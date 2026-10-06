"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import type { RecordHeaderAction } from "@/lib/portals/record-sections";

/**
 * Section header card for manager resident record tabs (studio-redesign C2-RT3).
 *
 * It carries no section name: the rail already says which section is open, so the card holds
 * only the blue underline tabs on the left and the section's icon actions on the right
 * (captain, 2026-10-05 round 2).
 */
export function ManagerResidentSectionToolbar({
  actions,
  onAction,
  destinationRow,
  search,
  extraActions,
  className,
}: {
  actions: RecordHeaderAction[];
  onAction: (actionId: string) => void;
  destinationRow?: ReactNode;
  search?: { value: string; onChange: (next: string) => void; placeholder?: string; dataAttr?: string };
  /** More icon actions that belong to the whole tab (never a ⋯ menu): Settings, a selection's bulk actions. */
  extraActions?: ReactNode;
  className?: string;
}) {
  const primaryIndex = actions.findIndex((a) => a.tone === "primary");
  const primary = primaryIndex >= 0 ? actions[primaryIndex] : undefined;
  const secondary = actions.filter((_, i) => i !== primaryIndex);
  const headerRow = destinationRow ? (
    <div className="flex min-w-0 items-center gap-1" data-attr="resident-section-header">
      <div className="min-w-0 flex-1">{destinationRow}</div>
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
          {extraActions}
        </>
      }
      primary={
        primary ? (
          // An "add" action stays the round +; any other primary (Approve, Run background check,
          // Send lease) is its own glyph in the primary tone, icon-only like the rest of the header
          // (the word is the tooltip and aria-label).
          primary.icon === Plus ? (
            <PortalPrimaryIconAction
              label={primary.label}
              data-attr={`resident-section-action-${primary.id}`}
              onClick={() => onAction(primary.id)}
            />
          ) : (
            <PortalIconAction
              icon={primary.icon}
              label={primary.label}
              tone="primary"
              data-attr={`resident-section-action-${primary.id}`}
              onClick={() => onAction(primary.id)}
            />
          )
        ) : undefined
      }
    />
  );
}
