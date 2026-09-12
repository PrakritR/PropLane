"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Utility control — Filter, Settings, Share, Export, Edit, Delete.
 *
 * An icon AND its word from `md` up (round 3: two lookalike glyphs at the end
 * of every list bar said nothing about which was Filter and which was
 * Settings). On a phone it is the bare glyph with a 44px hit target and the
 * word as the tooltip and accessible name. One icon per job, the same icon
 * everywhere. Primary create/confirm actions keep a regular `Button`.
 */
export const PortalIconAction = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: LucideIcon;
    /** Accessible name; doubles as the tooltip. "Filter · 2 active" shows as "Filter". */
    label: string;
    /** The word shown beside the icon from `md` up; derived from `label` when omitted. */
    shortLabel?: string;
    /** Draws the glyph in the brand colour (e.g. a "new message" pen). */
    tone?: "default" | "primary" | "danger";
    /** Marks an active state (an applied filter) with a soft fill. */
    active?: boolean;
    /** Icon only at every width (a toolbar that truly has no room). */
    iconOnly?: boolean;
  }
>(function PortalIconAction(
  { icon: Icon, label, shortLabel, tone = "default", active = false, iconOnly = false, className, type = "button", ...rest },
  ref,
) {
  const word = shortLabel ?? visibleWord(label);
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      data-slot="portal-icon-action"
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 outline-none transition md:size-10",
        "hover:bg-[var(--secondary)]/70 focus-visible:ring-2 focus-visible:ring-primary/30 active:bg-[var(--secondary)] disabled:opacity-50",
        !iconOnly && "md:h-9 md:w-auto md:gap-1.5 md:rounded-full md:border md:border-border md:bg-card md:px-3 md:text-[13px] md:font-semibold md:hover:bg-accent/50",
        tone === "primary" ? "text-primary" : tone === "danger" ? "text-red-600" : "text-foreground/80 hover:text-foreground",
        active && "bg-accent text-primary md:border-primary/40",
        className,
      )}
      {...rest}
    >
      <Icon className="size-[18px] md:size-4" strokeWidth={1.75} aria-hidden />
      {!iconOnly ? <span className="hidden md:inline">{word}</span> : null}
    </button>
  );
});

/** "Filter · 2 active" → "Filter"; "Resident settings" → "Settings"; short labels stay whole. */
function visibleWord(label: string): string {
  const head = label.split(" · ")[0]!.trim();
  if (head.length <= 12) return head;
  const last = head.split(/\s+/).pop() ?? head;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** Blue primary page action beside the title ("+ Add property", "+ Add tour"). */
export const PORTAL_PAGE_PRIMARY_ACTION_BTN =
  "portal-command-primary box-border !h-10 !min-h-10 shrink-0 rounded-lg border border-transparent px-3.5 text-sm font-semibold shadow-none whitespace-nowrap";
