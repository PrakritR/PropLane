"use client";

import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The "N faces, one cell" primitive interior.dev's Loading Button / Copy
 * Button / Skeleton Swap each rebuild independently in their own source —
 * built once here per the research §4. Every direct child renders in the SAME
 * CSS grid cell (`grid-area: 1 / 1`), so swapping which one is visible never
 * changes the container's width or height ("Button owns loading" already
 * guards double-submit; this only adds the zero-layout-shift face swap on
 * top). The face whose key matches `activeKey` gets `data-active`; everything
 * else fades via `tokens.css`'s crossfade duration, or vanishes instantly
 * under reduced motion (the CSS media query in `tokens.css` collapses the
 * duration to 0 — no separate reduced-motion branch needed here).
 *
 * Children must be direct elements with a `data-face` prop matching a key in
 * `activeKey`'s set — see `Face` below.
 */
export function CrossfadeSlot({
  activeKey,
  children,
  className,
}: {
  activeKey: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("motion-crossfade-slot", className)} data-active-face={activeKey}>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child;
        const face = child as ReactElement<{ face?: string }>;
        // Only the active face stays reachable to assistive tech — the
        // inactive one(s) keep their text in the DOM (nothing to remount on
        // swap) but must not double up the accessible name / live-region
        // announcement.
        return cloneElement(face, { "aria-hidden": face.props.face !== activeKey } as never);
      })}
    </span>
  );
}

/** One face inside a {@link CrossfadeSlot}. `face` must match a possible `activeKey`. */
export function CrossfadeFace({
  face,
  children,
  className,
  "aria-hidden": ariaHidden,
}: {
  face: string;
  children: ReactNode;
  className?: string;
  "aria-hidden"?: boolean;
}) {
  return (
    <span className={cn("motion-crossfade-face", className)} data-face={face} aria-hidden={ariaHidden}>
      {children}
    </span>
  );
}
