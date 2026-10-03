"use client";

import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_BUTTON_CLASS, RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { cn } from "@/lib/utils";

export type PortalRowMenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  /** Red, and always drawn last under a divider (Delete). */
  danger?: boolean;
  disabled?: boolean;
  dataAttr?: string;
};

/**
 * The one ⋯ on a record row or card: actions in the order given — Edit first —
 * and every `danger` action last, red, under a divider. The menu renders through
 * a portal (`DropdownMenuContent`), so a card with `overflow: hidden` never clips
 * it. Unlike `RowActionsMenu` it does not cap the number of actions.
 */
export function PortalRowMenu({
  label,
  items,
  triggerClassName,
  iconClassName,
  dataAttr = "portal-row-menu",
}: {
  label: string;
  items: readonly (PortalRowMenuItem | null | false | undefined)[];
  triggerClassName?: string;
  iconClassName?: string;
  dataAttr?: string;
}) {
  const actions = items.filter((item): item is PortalRowMenuItem => Boolean(item));
  const regular = actions.filter((item) => !item.danger);
  const danger = actions.filter((item) => item.danger);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className={cn(
          triggerClassName ?? cn(RECORD_ACTION_TRIGGER_BUTTON_CLASS, "inline-flex items-center justify-center hover:bg-foreground/[0.06]"),
        )}
        aria-label={`Actions for ${label}`}
        data-attr={dataAttr}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal className={iconClassName ?? RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {regular.map((item) => (
          <DropdownMenuItem key={item.id} disabled={item.disabled} data-attr={item.dataAttr} onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
        {regular.length > 0 && danger.length > 0 ? <DropdownMenuSeparator /> : null}
        {danger.map((item) => (
          <DropdownMenuItem
            key={item.id}
            className="text-red-700 focus:text-red-700"
            disabled={item.disabled}
            data-attr={item.dataAttr}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
