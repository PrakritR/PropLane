"use client";

import { useEffect } from "react";

/**
 * How many mounted surfaces currently want the sticky chrome.
 *
 * The attribute is a single document-level flag, but SEVERAL components own it —
 * `ManagerPortalPageShell` for list pages and `PortalRecordDetailPage` for detail
 * pages, and a route change mounts the new one while the old one is still
 * unmounting. With a plain set/delete, the outgoing page's cleanup runs after the
 * incoming page's effect and deletes the flag the incoming page just set.
 *
 * The surface that lost the flag keeps its own `flex-1 … overflow-y-auto` scroll
 * body, but `#portal-main-content` is no longer clipped to a flex viewport — so
 * `flex-1` resolves against nothing, the body grows to its full content height,
 * and the page ends up with two nested scrollers and trailing dead space below
 * the content. That is the "I can scroll all the way down for some reason" on
 * the property detail tabs (AXI-162), and it reproduced on NAVIGATION only,
 * never on a fresh load, which is exactly what a last-writer-wins cleanup looks
 * like.
 *
 * Counting fixes it: the flag is removed only when the last owner unmounts.
 */
let stickyChromeOwners = 0;

/** Locks portal main to a flex viewport so page chrome stays fixed and list bodies scroll below. */
export function usePortalStickyPageChrome(active: boolean) {
  useEffect(() => {
    if (!active) return;
    stickyChromeOwners += 1;
    document.documentElement.dataset.portalStickyChrome = "true";
    return () => {
      stickyChromeOwners = Math.max(0, stickyChromeOwners - 1);
      if (stickyChromeOwners === 0) {
        delete document.documentElement.dataset.portalStickyChrome;
      }
    };
  }, [active]);
}

/** Test-only reset — the counter is module state and would leak between cases. */
export function __resetPortalStickyPageChromeForTests() {
  stickyChromeOwners = 0;
  if (typeof document !== "undefined") {
    delete document.documentElement.dataset.portalStickyChrome;
  }
}
