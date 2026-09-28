"use client";

import { useLayoutEffect } from "react";
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
 * Ref-counted at module scope (not per-instance state) so a nested modal
 * (`dismissBlocked`, e.g. a holding-fee confirmation opened from inside a
 * bigger modal) doesn't un-inert the page the moment the INNER one closes —
 * only the LAST one closing restores it. Applied once, at the 0→1 edge, by
 * walking `document.body`'s current children and skipping whichever one
 * already hosts an open modal/drawer host node (matched by
 * `[data-slot="modal-radix-dialog"]` / `[data-slot="modal-vaul-drawer"]`,
 * both already stamped by `ModalShell`) — so a modal opened AFTER that never
 * gets excluded by accident, and a modal's own field-select dropdowns
 * (portaled to `document.body` after the fact) are simply never touched.
 */
let openCount = 0;
let releaseFns: Array<() => void> = [];

const MODAL_HOST_SELECTOR = '[data-slot="modal-radix-dialog"], [data-slot="modal-vaul-drawer"]';

function inertOutsideOpenModals(): () => void {
  if (typeof document === "undefined") return () => {};
  const hosts = document.querySelectorAll(MODAL_HOST_SELECTOR);
  if (!hosts.length) return () => {};
  const restores: Array<() => void> = [];
  Array.prototype.forEach.call(document.body.children, (child: Element) => {
    const hostsAModal = Array.prototype.some.call(hosts, (host: Element) => child.contains(host));
    if (hostsAModal) return;
    if (child.hasAttribute("inert")) return; // already inert for some other reason — never our job to remove it
    child.setAttribute("inert", "");
    restores.push(() => child.removeAttribute("inert"));
  });
  return () => restores.forEach((fn) => fn());
}

/** Call from `ModalShell` (or any modal/drawer/sheet host) with `active = open && isClient`. */
export function useInertOutsideModal(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    openCount += 1;
    if (openCount === 1) {
      releaseFns.push(inertOutsideOpenModals());
    }
    return () => {
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) {
        releaseFns.forEach((fn) => fn());
        releaseFns = [];
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
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
