// @vitest-environment jsdom
//
// Pins the shared motion layer's one reduced-motion contract (M001,
// src/components/ui/motion/use-reduced-motion.ts): `useReducedMotion()`
// mirrors `prefers-reduced-motion: reduce`, and a component built on it (the
// Button's M003 success flash) skips its own decorative animation state
// entirely rather than playing a shortened version — "skip the trip, never
// the state change" (review-0927/interior-dev-research.md §4).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { useReducedMotion } from "@/components/ui/motion/use-reduced-motion";
import { Button } from "@/components/ui/button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Minimal MediaQueryList stub — jsdom has no real media-query engine. */
function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<() => void>();
  let matches = initialMatches;
  const mql = {
    get matches() {
      return matches;
    },
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  return {
    set(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb());
    },
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useReducedMotion", () => {
  it("reflects the OS preference on mount", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it("stays false when the OS has no preference", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it("updates live if the preference changes while mounted", () => {
    const mql = stubMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    act(() => mql.set(true));
    expect(result.current).toBe(true);
  });
});

describe("Button under reduced motion (M003)", () => {
  it("never shows the decorative success check when the OS prefers reduced motion", async () => {
    stubMatchMedia(true);
    const d = deferred();
    render(<Button onClick={() => d.promise}>Save</Button>);
    const btn = screen.getByRole("button", { name: /save/i });

    fireEvent.click(btn);
    d.resolve();
    await d.promise;
    await waitFor(() => expect(btn).not.toBeDisabled());

    // The real state change (re-armed, enabled) always happens — only the
    // decorative trip (the check-mark flash) is skipped.
    expect(screen.queryByTestId("button-success-check")).toBeNull();
    expect(screen.queryByTestId("button-spinner")).toBeNull();
  });

  it("still disables and announces aria-busy while pending, reduced motion or not", () => {
    stubMatchMedia(true);
    const d = deferred();
    render(<Button onClick={() => d.promise}>Send</Button>);
    const btn = screen.getByRole("button", { name: /send/i });
    fireEvent.click(btn);
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });
});
