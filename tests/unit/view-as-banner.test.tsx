// @vitest-environment jsdom
//
// "View as" banner: the visible half of the read-only promise. The server is the
// control (view-as-middleware.test.ts); this proves the page cannot look like it
// saved, tells the operator how long is left, and puts everything back on End.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => ({
  has_opted_out_capturing: vi.fn(() => false),
  opt_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(),
  stopSessionRecording: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthogMock }));

import { ViewAsBanner } from "@/components/portal/view-as-banner";

const originalFetch = window.fetch;
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  posthogMock.has_opted_out_capturing.mockReturnValue(false);
  window.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof window.fetch;
  Object.defineProperty(window, "location", { value: { ...window.location, assign, origin: window.location.origin, href: window.location.href }, writable: true });
});

afterEach(() => {
  cleanup();
  window.fetch = originalFetch;
});

const props = {
  name: "Mia Manager",
  portal: "manager" as const,
  expiresAtMs: Date.now() + 29 * 60_000 + 30_000,
  endHref: "/admin/axis-users/manager-abc",
};

describe("ViewAsBanner", () => {
  it("names who is viewed, the portal, read-only and the minutes left", () => {
    render(<ViewAsBanner {...props} />);
    expect(screen.getByRole("status").textContent).toContain("Viewing as Mia Manager · Manager portal · read-only · 30 min left");
    expect(screen.getByRole("button", { name: "End" })).toBeTruthy();
  });

  it("stamps data-view-as on <html> and removes it on unmount", () => {
    const { unmount } = render(<ViewAsBanner {...props} />);
    expect(document.documentElement.hasAttribute("data-view-as")).toBe(true);
    unmount();
    expect(document.documentElement.hasAttribute("data-view-as")).toBe(false);
  });

  it("turns a same-origin write into an instant explained refusal and never sends it", async () => {
    const sent = vi.fn(async () => new Response("{}", { status: 200 }));
    window.fetch = sent as typeof window.fetch;
    render(<ViewAsBanner {...props} />);

    let status = 0;
    await act(async () => {
      const res = await window.fetch("/api/property-records", { method: "POST", body: "{}" });
      status = res.status;
      expect(await res.json()).toEqual({ error: "read_only_view_as" });
    });
    expect(status).toBe(403);
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Read-only while viewing as Mia Manager");
  });

  it("lets reads and the End request through", async () => {
    const sent = vi.fn(async () => new Response("{}", { status: 200 }));
    window.fetch = sent as typeof window.fetch;
    render(<ViewAsBanner {...props} />);
    await act(async () => {
      await window.fetch("/api/property-records");
      await window.fetch("/api/admin/preview", { method: "DELETE" });
    });
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("silences analytics while open and restores only what it changed", () => {
    const { unmount } = render(<ViewAsBanner {...props} />);
    expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthogMock.stopSessionRecording).toHaveBeenCalled();
    unmount();
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);

    cleanup();
    vi.clearAllMocks();
    posthogMock.has_opted_out_capturing.mockReturnValue(true);
    render(<ViewAsBanner {...props} />).unmount();
    expect(posthogMock.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled();
  });

  it("End calls DELETE /api/admin/preview, then lands on the account record", async () => {
    const sent = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    window.fetch = sent as typeof window.fetch;
    render(<ViewAsBanner {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/admin/axis-users/manager-abc"));
    expect(sent).toHaveBeenCalledWith("/api/admin/preview", expect.objectContaining({ method: "DELETE" }));
  });

  it("ends itself when the session expires", async () => {
    window.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof window.fetch;
    render(<ViewAsBanner {...props} expiresAtMs={Date.now() - 1000} />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/admin/axis-users/manager-abc"));
  });
});
