"use client";

import type { LucideIcon } from "lucide-react";
import {
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  DoorOpen,
  FileText,
  Home,
  ListTodo,
  Megaphone,
  MessageSquare,
  HardHat,
  Plus,
  UserPlus,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Outer padding around dashed add rows in list panes — scales with viewport. */
export const PORTAL_LIST_ADD_ROW_WRAP_CLASS =
  "portal-list-add-row-wrap px-3 py-4 max-md:px-2.5 sm:py-6 max-lg:[&:has(.portal-list-add-row--inline)]:px-2.5 max-lg:[&:has(.portal-list-add-row--inline)]:py-2";

export const PORTAL_LIST_ADD_ROW_CLASS =
  "portal-list-add-row flex w-full min-h-[9rem] flex-col items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed border-border bg-card px-5 py-8 text-center transition-colors sm:min-h-[10rem] sm:py-10 hover:border-primary/40 hover:bg-primary/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/** Compact dashed row when a list already has items (list footers). */
export const PORTAL_LIST_ADD_ROW_INLINE_CLASS =
  "portal-list-add-row portal-list-add-row--inline flex w-full min-h-11 flex-row items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-card px-4 py-2.5 text-center transition-colors hover:border-primary/40 hover:bg-primary/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/**
 * Dashed list footer — tap to add a property, resident, lease, application, etc.
 *
 * Visible text is a plain "Add" with a plus glyph on every list (the redesign
 * dropped the per-list icon and the uppercase tracking); the accessible name
 * still says what the row adds.
 */
export function PortalListAddRow({
  label,
  ariaLabel,
  // Kept for callers; every add row draws the same plus glyph now.
  icon,
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
  void icon;
  const displayLabel = label.trim();
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
          <Plus
            className={cn("text-primary", inline ? "h-[18px] w-[18px]" : "h-7 w-7")}
            strokeWidth={2}
            aria-hidden
          />
          <span className={cn("flex flex-col items-center gap-1", inline && "flex-row gap-2")}>
            <span className={cn("font-semibold text-primary", inline ? "text-sm" : "text-sm sm:text-[15px]")}>
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
  tour: DoorOpen,
  promotion: Megaphone,
  request: ListTodo,
  service: ClipboardList,
  inspection: ClipboardCheck,
  conversation: MessageSquare,
  vendor: HardHat,
  team: Users,
  payment: CreditCard,
} satisfies Record<string, LucideIcon>;
