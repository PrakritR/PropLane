// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const refreshSession = vi.fn();
const signOut = vi.fn();
const client = { auth: { getSession, refreshSession, signOut } };

vi.mock("@/lib/native/detect-native", () => ({ detectNativePlatformSync: () => null }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => client }));

import { PortalSessionKeepalive } from "@/components/portal/portal-session-keepalive";

function session(expiresAt: number) {
  return { user: { id: "viewer-1" }, expires_at: expiresAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ data: { session: session(Math.floor(Date.now() / 1000) + 60 * 60) }, error: null });
  refreshSession.mockResolvedValue({ error: null });
  signOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalSessionKeepalive", () => {
  it("does not rotate a safely fresh session on mount or visibility", async () => {
    render(<PortalSessionKeepalive />);
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("refreshes a stale session once", async () => {
    getSession.mockResolvedValue({ data: { session: session(Math.floor(Date.now() / 1000) + 30) }, error: null });
    render(<PortalSessionKeepalive />);
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
  });

  it("coalesces simultaneous stale mount and visible refreshes", async () => {
    let resolveRefresh: ((value: { error: null }) => void) | undefined;
    getSession.mockResolvedValue({ data: { session: session(Math.floor(Date.now() / 1000) + 30) }, error: null });
    refreshSession.mockImplementation(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    render(<PortalSessionKeepalive />);
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(refreshSession).toHaveBeenCalledTimes(1);
    await act(async () => resolveRefresh?.({ error: null }));
  });
});
