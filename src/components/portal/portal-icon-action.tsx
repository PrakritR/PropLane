"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Plus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CrossfadeFace, CrossfadeSlot } from "@/components/ui/motion/crossfade-slot";
import { useReducedMotion } from "@/components/ui/motion/use-reduced-motion";

/**
 * Instant hover / focus-visible label for an icon-only control: a small dark pill under the button, no
 * delay, `pointer-events-none`. It is portaled to `document.body` with fixed positioning because the
 * command bars these buttons sit in scroll horizontally (`overflow-x-auto`), which would clip an
 * absolutely-positioned child. `align="end"` right-aligns to the button so a header action at the
 * viewport's right edge never overflows; otherwise it is centred (clamped to stay on screen).
 *
 * It sits above every other layer in the stack — the dialog stack (z-90/91), the listing wizard
 * overlay (z-80), the field-select menus (z-10060) and the phone sheet (z-10070/10071) — because an
 * icon action is the chrome of all of them and the native `title` is gone. `pointer-events-none`
 * means a layer above nothing can be blocked by it.
 */
function useIconTip(label: string, align: "center" | "end") {
  const [tip, setTip] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const [shown, setShown] = useState(false);

  // Positioned from the event's own target, so no ref is read during render.
  const show = useCallback(
    (el: HTMLElement) => {
      if (typeof window === "undefined") return;
      const rect = el.getBoundingClientRect();
      const top = rect.bottom + 6;
      if (align === "end") {
        setTip({ top, right: Math.max(8, window.innerWidth - rect.right) });
      } else {
        const center = rect.left + rect.width / 2;
        setTip({ top, left: Math.min(Math.max(center, 64), window.innerWidth - 64) });
      }
    },
    [align],
  );
  const hide = useCallback(() => {
    setShown(false);
    setTip(null);
  }, []);

  useEffect(() => {
    if (!tip) return;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [tip]);

  const node =
    tip && typeof document !== "undefined"
      ? createPortal(
          <span
            role="presentation"
            data-slot="portal-icon-tooltip"
            style={{ top: tip.top, left: tip.left, right: tip.right }}
            className={cn(
              "pointer-events-none fixed z-[10090] whitespace-nowrap rounded-[5px] bg-[#15171c] px-[7px] py-[3px] text-[11.5px] font-[550] leading-4 text-white transition-opacity duration-100 dark:bg-neutral-100 dark:text-neutral-900",
              align === "center" && "-translate-x-1/2",
              shown ? "opacity-100" : "opacity-0",
            )}
          >
            {label}
          </span>,
          document.body,
        )
      : null;

  return { node, show, hide };
}

/** Runs the caller's own handler, then ours. */
function chain<E>(own: ((e: E) => void) | undefined, ours: () => void) {
  return (e: E) => {
    own?.(e);
    ours();
  };
}

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
    /**
     * A record page's own header row (view public/edit/share/copy/delete): a
     * 40px circle with a 1px border, distinct from a list band's bare glyph.
     * The FIRST ringed action on a page is filled solid — there is exactly one
     * per screen — every other one is outlined.
     */
    ring?: boolean;
    /** The one filled `ring` action per record header — the record's primary act. */
    ringPrimary?: boolean;
    /** M009 — overrides the default `<Icon>` render (e.g. {@link CopyIconAction}'s check-morph). The `icon` prop is still required for a11y fallback callers that don't need this. */
    iconSlot?: ReactNode;
  }
>(function PortalIconAction(
  // `shortLabel` / `iconOnly` are accepted and ignored — see the props above.
  { icon: Icon, label, shortLabel: _shortLabel, tone = "default", active = false, iconOnly: _iconOnly, badge = null, ring = false, ringPrimary = false, iconSlot, className, type = "button", onMouseEnter, onMouseLeave, onFocus, onBlur, onClick, ...rest },
  ref,
) {
  const tip = useIconTip(label, ring ? "end" : "center");
  return (
    <>
    <button
      ref={ref}
      type={type}
      aria-label={label}
      // A disabled button fires no mouse events, so the instant label can't show; it keeps the native one.
      title={rest.disabled ? label : undefined}
      onMouseEnter={(e: MouseEvent<HTMLButtonElement>) => {
        onMouseEnter?.(e);
        tip.show(e.currentTarget);
      }}
      onMouseLeave={chain<MouseEvent<HTMLButtonElement>>(onMouseLeave, tip.hide)}
      onFocus={(e: FocusEvent<HTMLButtonElement>) => {
        onFocus?.(e);
        // Keyboard focus only — a mouse click focusing the button must not pin the label open.
        if (e.currentTarget.matches(":focus-visible")) tip.show(e.currentTarget);
      }}
      onBlur={chain<FocusEvent<HTMLButtonElement>>(onBlur, tip.hide)}
      onClick={chain<MouseEvent<HTMLButtonElement>>(onClick, tip.hide)}
      aria-pressed={active || undefined}
      data-slot="portal-icon-action"
      data-ring={ring || undefined}
      className={cn(
        "relative inline-flex size-11 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 outline-none transition md:size-9 lg:size-8",
        "hover:bg-[var(--secondary)]/70 focus-visible:ring-2 focus-visible:ring-primary/30 active:bg-[var(--secondary)] disabled:opacity-50",
        tone === "primary" ? "text-primary" : tone === "danger" ? "text-red-600" : "text-foreground/80 hover:text-foreground",
        active && "bg-accent text-primary",
        ring &&
          (ringPrimary
            ? "!size-11 rounded-full md:!size-9 lg:!size-8 border border-transparent bg-[var(--btn-primary)] !text-white shadow-[0_1px_2px_rgba(40,99,240,0.35)] hover:bg-[#1e4fd6] active:scale-95"
            : "!size-11 rounded-full md:!size-9 lg:!size-8 border border-border bg-card hover:bg-accent/60"),
        className,
      )}
      {...rest}
    >
      {iconSlot ?? <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />}
      <PortalIconBadge badge={badge} />
    </button>
    {tip.node}
    </>
  );
});

/**
 * M009 — copy button check morph. Exact fit for AGENTS.md's icon-chrome rule
 * (tooltip-only label, no text pill): a width-locked morph from the copy
 * glyph to a drawn checkmark, reverting after ~1.6s, replacing a plain
 * toast-only "Copied" cue wherever a `PortalIconAction` already sits in a
 * title/card header. `onCopy` owns the actual clipboard write (and any
 * toast) exactly as it already did — this only adds the decorative morph on
 * top, the same "add a face swap without touching the real action" shape as
 * the Button's own M003 change.
 */
export const CopyIconAction = forwardRef<
  HTMLButtonElement,
  Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "onClick"
  > & {
    label: string;
    /** Performs the real copy (and any toast); may return a promise. The check morph only plays once this resolves. */
    onCopy: () => unknown;
    tone?: "default" | "primary" | "danger";
    badge?: "dot" | "warn" | "ok" | number | null;
    ring?: boolean;
    ringPrimary?: boolean;
  }
>(function CopyIconAction({ label, onCopy, className, ...rest }, ref) {
  const [copied, setCopied] = useState(false);
  const reducedMotion = useReducedMotion();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleClick = useCallback(() => {
    const result = onCopy();
    void Promise.resolve(result).then(() => {
      if (!mounted.current) return;
      setCopied(true);
      setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, reducedMotion ? 0 : 1600);
    });
  }, [onCopy, reducedMotion]);

  return (
    <PortalIconAction
      ref={ref}
      icon={Copy}
      label={copied ? "Copied" : label}
      onClick={handleClick}
      className={className}
      data-copied={copied || undefined}
      iconSlot={
        <CrossfadeSlot activeKey={copied ? "copied" : "idle"}>
          <CrossfadeFace face="idle">
            <Copy className="size-[18px]" strokeWidth={1.75} aria-hidden />
          </CrossfadeFace>
          <CrossfadeFace face="copied">
            <Check className="size-[18px] text-[var(--pl-good,theme(colors.emerald.600))]" strokeWidth={2} aria-hidden />
          </CrossfadeFace>
        </CrossfadeSlot>
      }
      {...rest}
    />
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
>(function PortalPrimaryIconAction({ label, icon: Icon = Plus, className, type = "button", onMouseEnter, onMouseLeave, onFocus, onBlur, onClick, ...rest }, ref) {
  const tip = useIconTip(label, "center");
  return (
    <>
    <button
      ref={ref}
      type={type}
      aria-label={label}
      // A disabled button fires no mouse events, so the instant label can't show; it keeps the native one.
      title={rest.disabled ? label : undefined}
      onMouseEnter={(e: MouseEvent<HTMLButtonElement>) => {
        onMouseEnter?.(e);
        tip.show(e.currentTarget);
      }}
      onMouseLeave={chain<MouseEvent<HTMLButtonElement>>(onMouseLeave, tip.hide)}
      onFocus={(e: FocusEvent<HTMLButtonElement>) => {
        onFocus?.(e);
        if (e.currentTarget.matches(":focus-visible")) tip.show(e.currentTarget);
      }}
      onBlur={chain<FocusEvent<HTMLButtonElement>>(onBlur, tip.hide)}
      onClick={chain<MouseEvent<HTMLButtonElement>>(onClick, tip.hide)}
      data-slot="portal-primary-icon-action"
      className={cn(
        "portal-command-primary relative ml-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full border-0 p-0 text-white outline-none transition md:size-9 lg:size-8",
        "bg-[var(--btn-primary)] shadow-[0_1px_2px_rgba(40,99,240,0.35)] hover:bg-[#1e4fd6] focus-visible:ring-2 focus-visible:ring-primary/40 active:scale-95 disabled:opacity-50 disabled:shadow-none",
        className,
      )}
      {...rest}
    >
      <Icon className="size-[18px]" strokeWidth={2.4} aria-hidden />
    </button>
    {tip.node}
    </>
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
