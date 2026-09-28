"use client";

/**
 * M016 — sortable table row-travel (FLIP).
 *
 * Technique ported from interior.dev's Sortable Table (MIT license,
 * github.com/ddoemonn/interior, © ozzy): re-sorting travels rows to their
 * new position instead of repainting the table instantly. Framed as a
 * FLIP ("First, Last, Invert, Play") React hook rather than the studio
 * prototype's direct DOM `tbody.appendChild` reorder, since here React (not
 * hand-rolled DOM code) owns row order and identity.
 *
 * Usage: give every reorderable row a stable key, register its DOM node via
 * the returned `registerRow(key)` ref callback, and call this hook with the
 * CURRENT order (an array of those same keys) on every render. When the
 * order actually changes between renders, each row's own last-measured
 * screen position is diffed against its new one and animated back to
 * identity with a CSS transform — no library, no second re-render.
 */
import { useLayoutEffect, useRef } from "react";
import { useReducedMotion } from "@/components/ui/motion/use-reduced-motion";

export function useFlipRows<K extends string>(orderKeys: readonly K[]) {
  const nodesRef = useRef<Map<K, HTMLElement>>(new Map());
  const prevRectsRef = useRef<Map<K, DOMRect>>(new Map());
  const reducedMotion = useReducedMotion();

  useLayoutEffect(() => {
    const nodes = nodesRef.current;
    const prevRects = prevRectsRef.current;

    if (!reducedMotion) {
      for (const key of orderKeys) {
        const el = nodes.get(key);
        const prevRect = prevRects.get(key);
        if (!el || !prevRect) continue;
        const newRect = el.getBoundingClientRect();
        const dy = prevRect.top - newRect.top;
        const dx = prevRect.left - newRect.left;
        if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
        el.classList.add("motion-flip-row");
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        // Force a reflow so the browser commits the "from" position before
        // the transition below is allowed to animate toward identity.
        void el.offsetWidth;
        el.style.transition = "";
        el.style.transform = "";
      }
    }

    const nextRects = new Map<K, DOMRect>();
    for (const key of orderKeys) {
      const el = nodes.get(key);
      if (el) nextRects.set(key, el.getBoundingClientRect());
    }
    prevRectsRef.current = nextRects;
    // Re-measuring is keyed on the row order itself, not on identity of the
    // array — a plain string join is a cheap, correct dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKeys.join("\u0001"), reducedMotion]);

  function registerRow(key: K) {
    return (el: HTMLElement | null) => {
      if (el) nodesRef.current.set(key, el);
      else nodesRef.current.delete(key);
    };
  }

  return { registerRow };
}
