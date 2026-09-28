"use client";

import { useCallback, useRef } from "react";
import type { Ref, RefCallback } from "react";
import { prefersReducedMotionNow } from "@/components/ui/motion/use-reduced-motion";

/**
 * M007 — real DOM `inert` on siblings while a modal/drawer is open.
 *
 * Radix Dialog already calls the `aria-hidden` package's `hideOthers()`
 * internally (`@radix-ui/react-dialog`), which marks outside content
 * `aria-hidden="true"`. The one genuinely better detail interior.dev's own
 * Modal/Drawer adds on top (research §2/§3) is real `inert` — which, unlike
 * `aria-hidden` alone, also removes the underlying page from tab order and
 * blocks pointer/touch interaction with it, not just from the accessibility
 * tree. This is additive: it changes nothing about Radix's own focus trap,
 * scroll lock, or `aria-hidden` — it only adds `inert` beside it.
 *
 * Applied from a CALLBACK REF on the modal/drawer content node, not a
 * `useEffect`/`useLayoutEffect` keyed on `open`: Radix's own `Portal` (which
 * both `Dialog.Portal` and vaul's `Drawer.Portal` build on) mounts in TWO
 * commits — it renders nothing on the first pass
 * (`useState(false)` + `useLayoutEffect(() => setMounted(true), [])`, the
 * same "wait for the client" shape `useIsClient` uses), then actually calls
 * `createPortal` once `mounted` flips. An effect on `ModalShell` keyed on
 * `open` fires once, on the FIRST of those commits, before the content node
 * exists, and never re-fires for the second commit (its dependency never
 * changes again). A callback ref on the content node itself sidesteps that
 * entirely — React calls it exactly when THAT node is actually inserted,
 * however many portal commits it took to get there.
 *
 * Ref-counted at module scope (not per-instance state) so a nested modal
 * (`dismissBlocked`, e.g. a holding-fee confirmation opened from inside a
 * bigger modal) doesn't un-inert the page the moment the INNER one closes —
 * only the LAST one closing restores it. Applied once, at the 0→1 edge, by
 * walking `document.body`'s current children and skipping whichever one
 * contains the modal's own content node — so a modal opened AFTER that never
 * gets excluded by accident, and a modal's own field-select dropdowns
 * (portaled to `document.body` after the fact) are simply never touched.
 */
let openCount = 0;
let releaseFns: Array<() => void> = [];

function applyInert(host: Element): () => void {
  const restores: Array<() => void> = [];
  Array.prototype.forEach.call(document.body.children, (child: Element) => {
    if (child.contains(host)) return;
    if (child.hasAttribute("inert")) return; // already inert for some other reason — never our job to remove it
    child.setAttribute("inert", "");
    restores.push(() => child.removeAttribute("inert"));
  });
  return () => restores.forEach((fn) => fn());
}

function acquire(host: Element) {
  openCount += 1;
  if (openCount === 1) releaseFns.push(applyInert(host));
}

function release() {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) {
    releaseFns.forEach((fn) => fn());
    releaseFns = [];
  }
}

function mergeRefs<T>(a: Ref<T> | undefined, b: RefCallback<T>): RefCallback<T> {
  return (node) => {
    if (typeof a === "function") a(node);
    else if (a && "current" in a) (a as { current: T | null }).current = node;
    b(node);
  };
}

/**
 * Returns a ref to attach to the modal/drawer's own content element
 * (`Dialog.Content` / `Drawer.Content`) — call ONLY while the caller intends
 * this instance to participate in the boundary (i.e. render it unconditionally
 * whenever the modal is open; the ref's mount/unmount IS the acquire/release
 * signal). `outerRef` is the caller-supplied `contentRef`, if any — merged in,
 * never replaced.
 */
export function useInertOutsideModalRef<T extends Element>(outerRef: Ref<T> | undefined): RefCallback<T> {
  const acquiredRef = useRef(false);
  const innerRef = useCallback((node: T | null) => {
    if (node) {
      if (!acquiredRef.current) {
        acquiredRef.current = true;
        acquire(node);
      }
    } else if (acquiredRef.current) {
      acquiredRef.current = false;
      release();
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- outerRef identity churn is fine; mergeRefs re-reads it each call
  return useCallback(mergeRefs(outerRef, innerRef), [outerRef, innerRef]);
}

/**
 * M007 — the modal panel's exit animation, via a detached clone.
 *
 * `ModalShell` returns `null` the instant `open` becomes `false` (so the
 * caller's own state fully owns "is this open", never a lingering unmount
 * timer) — which means Radix's own `data-[state=closed]:animate-out` classes
 * never get a chance to run: the whole `<Dialog.Root>` is gone from the React
 * tree in the SAME commit the state flips, before Radix's Presence can stage
 * an exit. The approved studio drawing hit this exact bug (see
 * `~/proplane-mock-kit/review-0927/studio-motion.md` "A real bug found and
 * fixed during verification") and fixed it the same way this does: the REAL
 * close always happens first, synchronously, exactly as it already did —
 * this only clones the panel's current DOM (read via `getBoundingClientRect`
 * BEFORE the close call, so layout is still live) into a disabled, `inert`,
 * `pointer-events:none` copy positioned exactly where the original was, fades
 * it out on top of whatever renders next, and removes it after the CSS
 * animation's own duration. If a later render tears down the page under it
 * before that timeout, the clone is a plain detached node — it goes with it.
 */
export function animateModalExitClone(node: HTMLElement | null, kind: "dialog" | "drawer") {
  if (!node || typeof document === "undefined") return;
  if (prefersReducedMotionNow()) return; // no-op under reduced motion — nothing to animate
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return; // already hidden/unmounted — nothing to clone
  const clone = node.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll<HTMLElement>("button, input, select, textarea, a, [tabindex]")
    .forEach((el) => {
      el.setAttribute("tabindex", "-1");
      if ("disabled" in el) (el as HTMLButtonElement).disabled = true;
    });
  clone.setAttribute("inert", "");
  clone.setAttribute("aria-hidden", "true");
  clone.style.position = "fixed";
  clone.style.top = `${rect.top}px`;
  clone.style.left = `${rect.left}px`;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.margin = "0";
  clone.style.zIndex = "999";
  clone.style.pointerEvents = "none";
  clone.classList.add(kind === "drawer" ? "motion-modal-exit-drawer-clone" : "motion-modal-exit-panel-clone");
  document.body.appendChild(clone);
  const ms = kind === "drawer" ? 220 : 160;
  setTimeout(() => {
    if (clone.isConnected) clone.remove();
  }, ms);
}
