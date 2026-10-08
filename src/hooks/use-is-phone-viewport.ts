"use client";

import { useSyncExternalStore } from "react";

/** Below Tailwind's `lg` — the width where the portal swaps to the phone chrome and bottom bar. */
const PHONE_QUERY = "(max-width: 1023px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

/**
 * True on a phone / tablet-portrait viewport (below `lg`). SSR-safe: the server and the first
 * client render both say false, so hydration never mismatches; desktop therefore never renders
 * phone-only UI at all.
 */
export function useIsPhoneViewport(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
