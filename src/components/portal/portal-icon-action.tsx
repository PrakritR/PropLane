"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Plus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Utility control — Filter, Settings, Share, Export, Edit, Delete.
 *
 * A bare glyph at every width. The word is the tooltip and the accessible
 * name, never visible text: the captain's standing rule for list chrome is
 * "icons for everything" (PLAN-0914-1345), the way Linear's filter / display
 * controls and Shopify's list toolbars read. One icon per job, the same icon
 * everywhere — `docs/portal-ui-system.md` keeps the vocabulary. A page's ONE
 * prominent action is {@link PortalPrimaryIconAction}, the filled blue circle.
 *
 * `badge` marks state the glyph alone cannot: `"dot"` for an applied filter,
 * a number for how many, `"warn"` (amber) for a setup step still open — a
 * messaging number not yet assigned — and `"ok"` (green) for a connection
 * that is live (Google Calendar).
 */
export const PortalIconAction = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: LucideIcon;
    /** Accessible name; doubles as the tooltip. "Filter · 2 active" shows as-is. */
    label: string;
    /** @deprecated The word is never drawn now; kept so call sites need not change. */
    shortLabel?: string;
    /** Draws the glyph in the brand colour (e.g. a "new message" pen). */
    tone?: "default" | "primary" | "danger";
    /** Marks an active state (an applied filter) with a soft fill. */
    active?: boolean;
    /** @deprecated Every icon action is icon-only now. */
    iconOnly?: boolean;
    /** State the glyph cannot carry: an applied filter, a count, an open setup step. */
    badge?: "dot" | "warn" | "ok" | number | null;
  }
>(function PortalIconAction(
  // `shortLabel` / `iconOnly` are accepted and ignored — see the props above.
  { icon: Icon, label, shortLabel: _shortLabel, tone = "default", active = false, iconOnly: _iconOnly, badge = null, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      data-slot="portal-icon-action"
      className={cn(
        "relative inline-flex size-11 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 outline-none transition md:size-9",
        "hover:bg-[var(--secondary)]/70 focus-visible:ring-2 focus-visible:ring-primary/30 active:bg-[var(--secondary)] disabled:opacity-50",
        tone === "primary" ? "text-primary" : tone === "danger" ? "text-red-600" : "text-foreground/80 hover:text-foreground",
        active && "bg-accent text-primary",
        className,
      )}
      {...rest}
    >
      <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
      <PortalIconBadge badge={badge} />
    </button>
  );
});

/**
 * The page's ONE prominent action — "Add property", "Link Airbnb", "New
 * message", "Upload". A filled blue circle, last in the list command bar, so
 * it is the only filled control on the page and still reads as "the" action
 * without a word. Same 44px target on phones as every other icon action.
 */
export const PortalPrimaryIconAction = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    /** Accessible name and tooltip — "Create", never a bare "+". */
    label: string;
    /** Defaults to a plus; a section whose primary is not "add" passes its own glyph. */
    icon?: LucideIcon;
  }
>(function PortalPrimaryIconAction({ label, icon: Icon = Plus, className, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      data-slot="portal-primary-icon-action"
      className={cn(
        "portal-command-primary relative ml-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full border-0 p-0 text-white outline-none transition md:size-9",
        "bg-[var(--btn-primary)] shadow-[0_2px_6px_color-mix(in_srgb,var(--btn-primary)_40%,transparent)] focus-visible:ring-2 focus-visible:ring-primary/40 active:scale-95 disabled:opacity-50 disabled:shadow-none",
        className,
      )}
      {...rest}
    >
      <Icon className="size-[18px]" strokeWidth={2.4} aria-hidden />
    </button>
  );
});

function PortalIconBadge({ badge }: { badge: "dot" | "warn" | "ok" | number | null }) {
  if (badge == null || badge === 0) return null;
  if (typeof badge === "number") {
    return (
      <span
        aria-hidden
        data-slot="portal-icon-badge"
        className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-extrabold leading-none text-white ring-2 ring-card"
      >
        {badge > 9 ? "9+" : badge}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-slot="portal-icon-badge"
      data-tone={badge}
      className={cn(
        "absolute right-1 top-1 size-2 rounded-full ring-2 ring-card",
        badge === "warn" ? "bg-amber-500" : badge === "ok" ? "bg-emerald-500" : "bg-primary",
      )}
    />
  );
}
