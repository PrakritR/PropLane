// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * QA C9: a work-number status fetch that fails once is retried once on its own
 * before "Messaging status unavailable" is shown.
 */

const h = vi.hoisted(() => ({
  snapshot: undefined as undefined | { ok: true; status: unknown } | { ok: false; error: true },
  listeners: new Set<() => void>(),
  loads: 0,
  resets: 0,
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", ready: true, email: "m@example.test" }),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/workspaces/selection", () => ({
  WORKSPACE_SELECTION_EVENT: "ws-selection",
  selectedWorkspaceId: () => "w1",
}));
vi.mock("@/lib/sms/manager-messaging-number-client", () => ({
  readManagerMessagingNumberStatusClient: () => h.snapshot,
  subscribeManagerMessagingNumberStatusClient: (listener: () => void) => {
    h.listeners.add(listener);
    return () => h.listeners.delete(listener);
  },
  loadManagerMessagingNumberStatusClient: async () => {
    h.loads += 1;
  },
  resetManagerMessagingNumberStatusClientCache: () => {
    h.resets += 1;
    h.snapshot = undefined;
    for (const listener of h.listeners) listener();
  },
}));

import { MESSAGING_STATUS_AUTO_RETRY_MS, useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";

function settle(snapshot: typeof h.snapshot) {
  h.snapshot = snapshot;
  for (const listener of h.listeners) listener();
}

beforeEach(() => {
  vi.useFakeTimers();
  h.snapshot = undefined;
  h.loads = 0;
  h.resets = 0;
  h.listeners.clear();
});
afterEach(() => vi.useRealTimers());

describe("useManagerMessagingNumberStatus auto retry", () => {
  it("does not show the error on the first failure; it asks again once", () => {
    const { result } = renderHook(() => useManagerMessagingNumberStatus());
    act(() => settle({ ok: false, error: true }));
    expect(result.current.statusError).toBe(false);
    expect(result.current.resolved).toBe(false);
    act(() => {
      vi.advanceTimersByTime(MESSAGING_STATUS_AUTO_RETRY_MS + 10);
    });
    expect(h.resets).toBe(1);
  });

  it("shows the error only after the retry failed too", () => {
    const { result } = renderHook(() => useManagerMessagingNumberStatus());
    act(() => settle({ ok: false, error: true }));
    act(() => {
      vi.advanceTimersByTime(MESSAGING_STATUS_AUTO_RETRY_MS + 10);
    });
    act(() => settle({ ok: false, error: true }));
    expect(result.current.statusError).toBe(true);
    act(() => {
      vi.advanceTimersByTime(MESSAGING_STATUS_AUTO_RETRY_MS * 3);
    });
    expect(h.resets).toBe(1);
  });

  it("never shows the error when the retry succeeds", () => {
    const { result } = renderHook(() => useManagerMessagingNumberStatus());
    act(() => settle({ ok: false, error: true }));
    act(() => {
      vi.advanceTimersByTime(MESSAGING_STATUS_AUTO_RETRY_MS + 10);
    });
    act(() => settle({ ok: true, status: { canSend: true } }));
    expect(result.current.statusError).toBe(false);
    expect(result.current.resolved).toBe(true);
  });
});
