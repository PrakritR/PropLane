"use client";

import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";

export type VendorRowMenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Red, and drawn last after a divider — a destructive action. */
  destructive?: boolean;
};

/**
 * The one ⋯ a vendor list row carries (Reviews, Payments, Quick replies):
 * a floating card headed by the record's name in grey, then its real actions
 * in order, a red destructive action last. Same shape as the Properties row
 * menu; it rides a row's `actions` slot as a sibling of the row's open button.
 */
export function VendorRowMenu({
  label,
  items,
  dataAttr = "vendor-row-menu",
}: {
  /** The record's name — the menu heading and the trigger's accessible name. */
  label: string;
  items: VendorRowMenuItem[];
  dataAttr?: string;
}) {
  if (items.length === 0) return null;
  const regular = items.filter((item) => !item.destructive);
  const destructive = items.filter((item) => item.destructive);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        type="button"
        aria-label={`${label} actions`}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-portal-row-ignore
        data-attr={dataAttr}
      >
        <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuLabel className="max-w-[16rem] truncate text-xs font-medium text-muted">{label}</DropdownMenuLabel>
        {regular.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={item.disabled}
            onSelect={item.onSelect}
            data-attr={`${dataAttr}-${item.id}`}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
        {destructive.length > 0 ? <DropdownMenuSeparator /> : null}
        {destructive.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={item.disabled}
            onSelect={item.onSelect}
            className="text-danger focus:text-danger"
            data-attr={`${dataAttr}-${item.id}`}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
