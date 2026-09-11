"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Plain utility icon control — Filter, Settings, Share, Export, Edit, Delete.
 *
 * The redesign keeps secondary tools compact: a bare glyph with no permanent
 * circle or border, an accessible name (also the native tooltip), and a 44px
 * hit target on phones (40px on desktop, where a pointer is precise). Primary
 * create/confirm/consequential actions keep a readable text label instead —
 * use a regular `Button` for those.
 */
export const PortalIconAction = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: LucideIcon;
    /** Accessible name; doubles as the tooltip. */
    label: string;
    /** Draws the glyph in the brand colour (e.g. a "new message" pen). */
    tone?: "default" | "primary" | "danger";
    /** Marks an active state (an applied filter) with a soft fill. */
    active?: boolean;
  }
>(function PortalIconAction({ icon: Icon, label, tone = "default", active = false, className, type = "button", ...rest }, ref) {
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
        tone === "primary" ? "text-primary" : tone === "danger" ? "text-red-600" : "text-foreground/80 hover:text-foreground",
        active && "bg-accent text-primary",
        className,
      )}
      {...rest}
    >
      <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
    </button>
  );
});

/** Blue primary page action beside the title ("+ Add property", "+ Add tour"). */
export const PORTAL_PAGE_PRIMARY_ACTION_BTN =
  "portal-command-primary box-border !h-10 !min-h-10 shrink-0 rounded-lg border border-transparent px-3.5 text-sm font-semibold shadow-none whitespace-nowrap";
