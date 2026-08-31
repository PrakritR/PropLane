"use client";

import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  CreditCard,
  FileText,
  Home,
  ListTodo,
  Megaphone,
  MessageSquare,
  HardHat,
  UserPlus,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Outer padding around dashed add rows in list panes — scales with viewport. */
export const PORTAL_LIST_ADD_ROW_WRAP_CLASS =
  "portal-list-add-row-wrap px-3 py-4 max-md:px-2.5 sm:py-5 max-lg:[&:has(.portal-list-add-row--inline)]:px-2.5 max-lg:[&:has(.portal-list-add-row--inline)]:py-2";

export const PORTAL_LIST_ADD_ROW_CLASS =
  "portal-list-add-row flex w-full min-h-[9.25rem] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-accent/10 px-4 py-10 text-center transition-colors sm:min-h-[10rem] sm:gap-3.5 sm:py-12 max-lg:min-h-[9.75rem] max-lg:py-11 hover:border-primary/40 hover:bg-primary/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/** Compact dashed row when a list already has items (mobile list footers). */
export const PORTAL_LIST_ADD_ROW_INLINE_CLASS =
  "portal-list-add-row portal-list-add-row--inline flex w-full min-h-0 flex-row items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-accent/10 px-4 py-3 text-center transition-colors hover:border-primary/40 hover:bg-primary/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 max-lg:py-2.5";

/**
 * Dashed list footer — tap to add a property, resident, lease, application, etc.
 */
export function PortalListAddRow({
  label,
  ariaLabel,
  icon: Icon = Home,
  hint,
  onClick,
  disabled = false,
  dataAttr,
  className,
  /** Dashed box only — no icon or label (still uses `label` for accessibility). */
  bare = false,
  /** Shorter row for list footers when items already exist above. */
  inline = false,
}: {
  label: string;
  /**
   * Accessible name, when the visible label is deliberately generic.
   *
   * These rows read a uniform "ADD" across the portal on purpose, but that
   * leaves a screen reader with several identically-named buttons on one page
   * and no way to tell a charge from a payment. Pass what the button actually
   * adds; the visible text is unchanged.
   */
  ariaLabel?: string;
  icon?: LucideIcon;
  /** Secondary line under the label (e.g. “Browse homes”). */
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  dataAttr?: string;
  className?: string;
  bare?: boolean;
  inline?: boolean;
}) {
  const displayLabel = label.trim().toUpperCase();
  const hintText = hint?.trim();

  return (
    <button
      type="button"
      data-attr={dataAttr}
      data-portal-list-add-row=""
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      className={cn(inline ? PORTAL_LIST_ADD_ROW_INLINE_CLASS : PORTAL_LIST_ADD_ROW_CLASS, className)}
    >
      {bare ? null : (
        <>
          <Icon
            className={cn("text-primary", inline ? "h-5 w-5" : "h-8 w-8")}
            strokeWidth={1.35}
            aria-hidden
          />
          <span className={cn("flex flex-col items-center gap-1", inline && "flex-row gap-2")}>
            <span
              className={cn(
                "font-bold uppercase tracking-[0.16em] text-primary",
                inline ? "text-[10px] tracking-[0.12em]" : "text-[11px]",
              )}
            >
              {displayLabel}
            </span>
            {hintText ? (
              <span className="text-xs font-medium normal-case tracking-normal text-muted">{hintText}</span>
            ) : null}
          </span>
        </>
      )}
    </button>
  );
}

export const PORTAL_LIST_ADD_ICONS = {
  property: Home,
  resident: UserPlus,
  application: ClipboardList,
  lease: FileText,
  promotion: Megaphone,
  request: ListTodo,
  service: ClipboardList,
  conversation: MessageSquare,
  vendor: HardHat,
  team: Users,
  payment: CreditCard,
} satisfies Record<string, LucideIcon>;
