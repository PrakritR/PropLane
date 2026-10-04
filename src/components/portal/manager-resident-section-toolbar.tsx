"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  title,
  className,
}: {
  actions: RecordHeaderAction[];
  onAction: (actionId: string) => void;
  destinationRow?: ReactNode;
  search?: { value: string; onChange: (next: string) => void; placeholder?: string; dataAttr?: string };
  overflowMenu?: ReactNode;
  /** Section label on the left for rows with no sub-tabs and no search, so the row is never an empty bar. */
  title?: string;
  className?: string;
}) {
  const primaryIndex = actions.findIndex((a) => a.tone === "primary");
  const primary = primaryIndex >= 0 ? actions[primaryIndex] : undefined;
  const secondary = actions.filter((_, i) => i !== primaryIndex);

  return (
    <PortalListControlStack
      className={className ?? "rs40 mb-2 max-lg:mb-1.5 plp-header-card"}
      variant="command"
      destinationRow={
        destinationRow ??
        (title && !search ? (
          <h2
            className="px-3 text-[15px] font-semibold leading-10 text-foreground"
            data-attr="resident-section-title"
          >
            {title}
          </h2>
        ) : undefined)
      }
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
          // An "add" action stays the round +; any other primary (Approve, Run background check,
          // Send lease) is a labelled pill so the verb is readable without a hover.
          primary.icon === Plus ? (
            <PortalPrimaryIconAction
              label={primary.label}
              data-attr={`resident-section-action-${primary.id}`}
              onClick={() => onAction(primary.id)}
            />
          ) : (
            <Button
              type="button"
              className="ml-1 !min-h-9 gap-1.5 !px-3.5 !py-1.5"
              data-attr={`resident-section-action-${primary.id}`}
              onClick={() => onAction(primary.id)}
            >
              <primary.icon className="size-4" strokeWidth={2} aria-hidden />
              {primary.label}
            </Button>
          )
        ) : undefined
      }
    />
  );
}
