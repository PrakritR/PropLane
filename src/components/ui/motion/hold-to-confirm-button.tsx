"use client";

/**
 * M008 — hold-to-confirm on destructive Delete/Remove confirms.
 *
 * Technique ported from interior.dev's Hold to Confirm (MIT license,
 * github.com/ddoemonn/interior, © ozzy) — the hold duration, the tolerance
 * that cancels a hold on pointer drift, and the "refuse a plain click" gate
 * are its own documented behaviour (see
 * ~/proplane-mock-kit/review-0927/interior-dev-research.md §2's "Hold to
 * Confirm" row and the approved studio drawing at
 * ~/proplane-mock-kit/proto/motion-0927.js's own M008 section), reimplemented
 * here as a real React component instead of the studio's DOM-delegation
 * version.
 *
 * Wired into {@link PortalDialog}'s danger-tone footer action — the one
 * `.plp-modal-actions`-equivalent shared by every destructive confirm in the
 * app (co-manager removal, cancel a tour, remove a fee row, sign-out, …).
 *
 * Unlike the studio prototype, this component does NOT shorten the hold
 * under reduced motion: the press duration is the actual confirmation gate,
 * not decoration, and shortening it to a single tap would turn a safety
 * rail into a hair-trigger for exactly the operators who asked their system
 * to slow down. Reduced motion only removes the smooth animated fill
 * (`.motion-hold-fill.is-reduced` in tokens.css) — the same "skip the trip,
 * never the state change" policy every other primitive in this folder
 * follows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/components/ui/motion/use-reduced-motion";
import { cn } from "@/lib/utils";

const HOLD_MS = 850;
const MOVE_TOLERANCE_PX = 10;
const REFUSED_FLASH_MS = 340;

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "metallic";

export function HoldToConfirmButton({
  onConfirm,
  children,
  className,
  disabled,
  loading,
  dataAttr,
  variant = "primary",
  holdMs = HOLD_MS,
}: {
  /** May return a promise — tracked the same way {@link Button}'s own auto promise-tracking works. */
  onConfirm: () => unknown;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  loading?: boolean;
  dataAttr?: string;
  variant?: ButtonVariant;
  holdMs?: number;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [phase, setPhase] = useState<"idle" | "holding" | "armed">("idle");
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const reducedMotion = useReducedMotion();

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef({ x: 0, y: 0 });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancelHold = useCallback(
    (showRefused: boolean) => {
      clearTimer();
      setPhase("idle");
      if (showRefused) {
        setRefused(true);
        setTimeout(() => {
          if (mounted.current) setRefused(false);
        }, REFUSED_FLASH_MS);
      }
    },
    [clearTimer],
  );

  const commit = useCallback(() => {
    setPhase("idle");
    const result = onConfirm();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      setBusy(true);
      (result as Promise<unknown>).then(
        () => {
          if (mounted.current) setBusy(false);
        },
        (error: unknown) => {
          if (mounted.current) setBusy(false);
          console.error("Hold-to-confirm action failed", error);
        },
      );
    }
  }, [onConfirm]);

  const startHold = useCallback(
    (x: number, y: number) => {
      if (disabled || loading || busy) return;
      startPos.current = { x, y };
      setRefused(false);
      setPhase("holding");
      clearTimer();
      timerRef.current = setTimeout(() => {
        if (mounted.current) setPhase("armed");
      }, holdMs);
    },
    [disabled, loading, busy, holdMs, clearTimer],
  );

  useEffect(() => {
    const btn = btnRef.current;
    if (!btn) return;

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      startHold(e.clientX, e.clientY);
    }
    function onPointerMove(e: PointerEvent) {
      if (phaseRef.current !== "holding") return;
      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;
      if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) cancelHold(true);
    }
    function onPointerUp() {
      if (phaseRef.current === "armed") commit();
      else if (phaseRef.current === "holding") cancelHold(true);
    }
    function onPointerLeave() {
      if (phaseRef.current === "holding") cancelHold(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
        // Suppress the browser's own native click-on-Enter/Space so the hold
        // gate — not a keyboard default — decides when the action fires.
        e.preventDefault();
        startHold(0, 0);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (phaseRef.current === "armed") commit();
      else if (phaseRef.current === "holding") cancelHold(true);
    }
    function onBlur() {
      if (phaseRef.current === "holding") cancelHold(false);
    }
    function onClickCapture(e: MouseEvent) {
      // Every commit happens programmatically above (commit()); a native
      // click — including a screen reader's synthetic activation — must
      // never independently fire the action a second time.
      e.preventDefault();
      e.stopPropagation();
    }

    btn.addEventListener("pointerdown", onPointerDown);
    btn.addEventListener("pointermove", onPointerMove);
    btn.addEventListener("pointerup", onPointerUp);
    btn.addEventListener("pointerleave", onPointerLeave);
    btn.addEventListener("keydown", onKeyDown);
    btn.addEventListener("keyup", onKeyUp);
    btn.addEventListener("blur", onBlur);
    btn.addEventListener("click", onClickCapture, true);
    return () => {
      btn.removeEventListener("pointerdown", onPointerDown);
      btn.removeEventListener("pointermove", onPointerMove);
      btn.removeEventListener("pointerup", onPointerUp);
      btn.removeEventListener("pointerleave", onPointerLeave);
      btn.removeEventListener("keydown", onKeyDown);
      btn.removeEventListener("keyup", onKeyUp);
      btn.removeEventListener("blur", onBlur);
      btn.removeEventListener("click", onClickCapture, true);
    };
  }, [startHold, cancelHold, commit]);

  const isHolding = phase === "holding" || phase === "armed";
  const isBusy = loading || busy;
  const hintId = dataAttr ? `${dataAttr}-hold-hint` : undefined;

  return (
    <Button
      ref={btnRef}
      type="button"
      variant={variant}
      disabled={disabled}
      loading={isBusy}
      data-attr={dataAttr}
      aria-describedby={hintId}
      className={cn("relative isolate overflow-hidden", refused && "motion-hold-refused", className)}
    >
      <span
        aria-hidden
        className={cn("motion-hold-fill", isHolding && "is-holding", reducedMotion && "is-reduced")}
        style={isHolding ? { transitionDuration: reducedMotion ? "0ms" : `${holdMs}ms` } : undefined}
      />
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
      {hintId ? (
        // aria-hidden here so this text never joins the button's accessible
        // NAME (which must stay exactly the label, e.g. "Delete") — it is
        // still read as the button's accessible DESCRIPTION via
        // aria-describedby above, which explicitly includes aria-hidden
        // sources per the accname spec.
        <span id={hintId} aria-hidden="true" className="sr-only">
          Press and hold to confirm. On a keyboard, hold Enter or Space.
        </span>
      ) : null}
    </Button>
  );
}
