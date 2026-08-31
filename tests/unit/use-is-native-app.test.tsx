// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useIsSmallPortalViewport, useNativeChrome } from "@/hooks/use-is-native-app";

declare global {
  var Capacitor: { isNativePlatform: () => boolean; getPlatform: () => string } | undefined;
}

describe("useNativeChrome", () => {
  afterEach(() => {
    cleanup();
    // @ts-expect-error test-only cleanup of the global Capacitor bridge stub
    delete globalThis.Capacitor;
  });

  it("resolves true synchronously from the Capacitor bridge marker, without waiting on the async @capacitor/core import", async () => {
    // Real native shells inject a fully-working `window.Capacitor` before any
    // page script runs. If the hook only trusted the async dynamic import (the
    // bug: a stalled/failed chunk load left `isNative` stuck at `false` forever
    // while the <head> script's sync check had already tagged `data-native`,
    // hiding the top nav via CSS and leaving the bottom bar's createPortal gated
    // on this hook rendering nothing — an empty bar with only the FAB visible),
    // this could take an extra tick or never resolve. It must not depend on that.
    globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };

    const { result } = renderHook(() => useNativeChrome());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("falls back to false when there is no native bridge at all (web)", async () => {
    const { result } = renderHook(() => useNativeChrome());
    await waitFor(() => expect(result.current).toBe(false));
  });
});

describe("useIsSmallPortalViewport", () => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = false;

  afterEach(() => {
    cleanup();
    listeners.clear();
    matches = false;
    vi.unstubAllGlobals();
  });

  function installMatchMedia(nextMatches: boolean) {
    matches = nextMatches;
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      matches,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
    }));
  }

  it("reads the current matchMedia snapshot synchronously on first client render", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useIsSmallPortalViewport());
    expect(result.current).toBe(true);
  });

  it("updates when matchMedia change fires after a viewport resize", async () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useIsSmallPortalViewport());
    expect(result.current).toBe(false);

    matches = true;
    for (const listener of listeners) {
      listener({ matches: true } as MediaQueryListEvent);
    }
    await waitFor(() => expect(result.current).toBe(true));
  });
});
