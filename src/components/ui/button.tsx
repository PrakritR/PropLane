"use client";

import { Slot } from "@radix-ui/react-slot";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { track } from "@/lib/analytics/track-client";
import { useReducedMotion } from "@/components/ui/motion/use-reduced-motion";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "metallic";

const variants: Record<Variant, string> = {
  primary:
    "text-white shadow-[0_8px_20px_-8px_color-mix(in_srgb,var(--btn-primary)_60%,transparent)] hover:brightness-110 active:scale-[0.99]",
  metallic:
    "text-[#08142e] shadow-[0_6px_16px_-6px_rgba(0,0,0,0.25)] hover:brightness-105 active:scale-[0.99]",
  secondary:
    "border border-primary/30 bg-transparent text-primary shadow-none hover:bg-primary/5 active:scale-[0.99]",
  ghost:
    "bg-transparent text-foreground/80 hover:bg-foreground/5 hover:text-foreground active:scale-[0.99]",
  danger:
    "bg-transparent text-danger shadow-none hover:bg-danger/5 active:scale-[0.99]",
  outline:
    "border border-border bg-card/80 text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-primary/30 hover:bg-card active:scale-[0.99] [html[data-theme=dark]_&]:portal-outline-control",
};

/**
 * The in-button spinner. Strokes use `currentColor` so it reads correctly on
 * every variant (white on primary, brand on secondary, red on danger) with no
 * per-variant CSS. `aria-hidden` because the button already carries `aria-busy`,
 * which is what assistive tech announces.
 */
function ButtonSpinner() {
  return (
    <svg
      className="h-4 w-4 shrink-0 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-testid="button-spinner"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** M003 — the brief post-save check, drawn in (not crossfaded in) so it reads as a completion, not a re-label. */
function ButtonSuccessCheck() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-testid="button-success-check"
    >
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The one shared Button. It forwards its ref, so callers can measure or anchor
 * it (`portal-filter-sort-sheet` anchors its sheet off one); with `asChild`,
 * Radix `Slot` forwards that ref on to the child element.
 *
 * On React 19 a function component takes `ref` as an ordinary prop, so no
 * `forwardRef` wrapper is needed — `ref` rides the props spread onto `Comp`
 * below. Coverage: `tests/unit/button-ref-forwarding.test.tsx`.
 *
 * ## Loading / double-submit protection
 *
 * A button that starts async work must show that it is working and must not be
 * firable twice. This component provides both, two ways:
 *
 * 1. **Automatic.** If `onClick` returns a promise, the button tracks it: it
 *    shows the spinner, sets `aria-busy`, and IGNORES further clicks until that
 *    promise settles. Most async call sites here are already
 *    `onClick={async () => …}`, so they gain this with no edit — including money
 *    paths (charges, payouts, application submit) where a double-fire posts the
 *    action twice.
 * 2. **Explicit `loading` prop.** For work this button does not own the promise
 *    for — a `type="submit"` inside a `<form onSubmit>`, or a parent that
 *    already tracks its own `saving` flag — pass `loading={saving}`.
 *
 * Either source disables the button, so `disabled` stays the single visual and
 * behavioural truth. Coverage: `tests/unit/button-loading-state.test.tsx`.
 *
 * `asChild` opts OUT of the injected spinner: `Slot` renders the caller's own
 * element (usually a `<Link>`) and a second child would break its single-child
 * contract. An explicit `loading` on an `asChild` button still sets `aria-busy`
 * and `data-loading` so the caller can style it.
 */
export function Button({
  className = "",
  variant = "primary",
  style,
  children,
  event,
  eventProps,
  onClick,
  asChild = false,
  loading,
  disabled,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  variant?: Variant;
  children: ReactNode;
  /** Optional named PostHog event fired on click (object_action, non-PII). */
  event?: string;
  /** Optional non-PII properties sent with `event`. */
  eventProps?: Record<string, string | number | boolean | undefined>;
  /** Render as the single child element (via Radix Slot) instead of a <button>, e.g. to wrap a <Link>. */
  asChild?: boolean;
  /**
   * Forces the loading state on. Use when the promise lives elsewhere (a form's
   * `onSubmit`, or a parent-owned `saving` flag). When `onClick` itself returns
   * a promise you do NOT need this — it is tracked automatically.
   */
  loading?: boolean;
  /**
   * May return a promise; while it is pending the button spins and ignores
   * clicks. The return type is `unknown` rather than `void | Promise<unknown>`
   * because many call sites use arrow shorthand that incidentally returns a
   * value (`() => setOpen(true) || ""`); the promise check below is a runtime
   * duck-type, so a non-promise return is simply ignored.
   */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => unknown;
  /** React 19 passes `ref` through `props`; declared here so callers can measure/anchor the button. */
  ref?: Ref<HTMLButtonElement>;
}) {
  const isPrimary = variant === "primary";
  const isMetallic = variant === "metallic";
  const Comp = asChild ? Slot : "button";

  const [pending, setPending] = useState(false);
  // M003 — a brief post-save check, purely decorative: never read by the
  // guard logic above or below. Kept as its OWN state (not derived from
  // `pending`) so clearing it can never re-disable or re-block the button —
  // `isDisabled` below intentionally does not consult this.
  const [successFlash, setSuccessFlash] = useState(false);
  const reducedMotion = useReducedMotion();
  // Guards the handler itself. State lands a render later, so a second click in
  // the same tick would slip past `pending` alone — this ref closes that window,
  // which is precisely the double-submit case that matters on the money paths.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isLoading = loading === true || pending;
  const isDisabled = disabled === true || isLoading;

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (inFlight.current || disabled === true || loading === true) {
        e.preventDefault();
        return;
      }
      if (event) track(event, eventProps);
      const result = onClick?.(e);
      if (typeof (result as Promise<unknown> | undefined)?.then !== "function") return;
      inFlight.current = true;
      setPending(true);
      const settle = () => {
        inFlight.current = false;
        // The click may have unmounted this button (a modal that closes on
        // save), so only touch state while still mounted.
        if (mounted.current) setPending(false);
      };
      // Handle BOTH outcomes here. A bare `.finally()` re-throws onto a derived
      // promise that nothing awaits, so a failing action would emit an
      // unhandled rejection the button — not the caller — created.
      //
      // Attaching any handler also marks the caller's promise handled, so the
      // failure is logged rather than swallowed. It is deliberately NOT
      // rethrown globally: this primitive renders on every screen, and turning
      // every pre-existing unhandled `onClick` rejection into an app-wide
      // uncaught error would be a louder regression than the one being fixed.
      // Call sites that need user-visible failure handling should catch and
      // surface it themselves, as the money paths already do.
      void Promise.resolve(result).then(
        () => {
          settle();
          // Success only — a rejection never gets the check. Skipped entirely
          // under reduced motion and for `asChild` (Slot demands exactly one
          // child, so there's no face-stack to flash there).
          if (mounted.current && !reducedMotion && !asChild) {
            setSuccessFlash(true);
            setTimeout(() => {
              if (mounted.current) setSuccessFlash(false);
            }, 900);
          }
        },
        (error: unknown) => {
          settle();
          console.error("Button action failed", error);
        },
      );
    },
    [asChild, disabled, event, eventProps, loading, onClick, reducedMotion],
  );

  return (
    <Comp
      className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold outline-none ring-primary/0 transition-[transform,box-shadow,filter,background-color,border-color] duration-200 ease-out focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 ${variants[variant]} ${className}`}
      style={
        isPrimary
          ? { background: "var(--btn-primary)", ...style }
          : isMetallic
            ? { background: "var(--btn-metallic)", boxShadow: "0 6px 16px -6px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.9)", ...style }
            : style
      }
      onClick={handleClick}
      // Only a real <button> takes `disabled`. Under `asChild` the child is
      // usually an <a>, where a `disabled` attribute is meaningless markup, so
      // forward it only when the caller asked for it (as it did before).
      disabled={asChild ? disabled : isDisabled}
      aria-busy={isLoading || undefined}
      data-loading={isLoading ? "true" : undefined}
      {...props}
    >
      {/*
        Under `asChild` Slot demands EXACTLY one child, so the spinner slot must
        collapse entirely — even to `null`, which still makes this an array of
        two and throws "Slot failed to slot onto its children".
      */}
      {asChild ? (
        children
      ) : isLoading ? (
        // M003 — the pending face fades/rises in on mount (`motion-face-in`,
        // tokens.css) rather than popping in, purely decorative on top of
        // (never instead of) the double-submit guard above. Only one face is
        // ever actually mounted at a time (never a `pending` + `success`
        // pair coexisting off-screen) so `button-spinner` genuinely leaves
        // the DOM the instant `isLoading` clears — the guard's own contract
        // (`queryByTestId("button-spinner")` is `null` at rest) is unchanged.
        <span className="motion-face-in inline-flex items-center gap-2">
          <ButtonSpinner />
          {children}
        </span>
      ) : successFlash ? (
        <span className="motion-face-in inline-flex items-center gap-2">
          <ButtonSuccessCheck />
          {children}
        </span>
      ) : (
        children
      )}
    </Comp>
  );
}
