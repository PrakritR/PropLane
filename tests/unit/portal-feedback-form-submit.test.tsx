// @vitest-environment jsdom
//
// N087: proves the redesigned feedback form actually reaches the EXISTING
// `/api/portal-bug-feedback` route with type/message/page in the payload —
// the acceptance edge a slow/contended browser proof could not finish in
// time for this batch. `usePortalFeedbackForm` is the shared submit logic
// behind both the Need Help panel and the standalone feedback modal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }) }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/demo-admin-ui", () => ({ emitAdminUi: vi.fn() }));

import { usePortalFeedbackForm } from "@/components/portal/portal-feedback-form";

function stubFetch(handler: (url: string, init: RequestInit | undefined) => { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const res = handler(url, init);
    return { ok: res.ok, status: res.status ?? (res.ok ? 200 : 500), json: res.json } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("usePortalFeedbackForm submit", () => {
  it("POSTs type, message (as description) and the current page to the existing feedback route", async () => {
    const fetchSpy = stubFetch((url) => {
      expect(url).toBe("/api/portal-bug-feedback");
      return { ok: true, json: async () => ({}) };
    });

    const { result } = renderHook(() =>
      usePortalFeedbackForm({
        reporterRole: "manager",
        reporterUserId: "user-1",
        reporterEmail: "manager2@test.proplane.local",
        reporterName: "Manager Two",
        onSubmitted: () => {},
        open: true,
      }),
    );

    // The page context effect (gated on `open`) runs before submit captures it.
    await waitFor(() => expect(result.current.pageContext).toBe("/"));

    act(() => result.current.setKind("idea"));
    act(() => result.current.setMessage("Please add a dark mode toggle to the calendar."));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { row: Record<string, unknown> };
    expect(body.row.type).toBe("feedback"); // "idea" buckets into the admin "feedback" tab
    expect(body.row.reportKind).toBe("idea");
    expect(body.row.description).toBe("Please add a dark mode toggle to the calendar.");
    expect(body.row.pageUrl).toBe("/");
    expect(body.row.reporterRole).toBe("manager");

    expect(result.current.submitted).toBe(true);
    expect(result.current.submitError).toBeNull();
  });

  it("buckets a Bug selection into the existing bug/feedback admin split without a new field", async () => {
    const fetchSpy = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const { result } = renderHook(() =>
      usePortalFeedbackForm({
        reporterRole: "resident",
        reporterUserId: "user-2",
        reporterEmail: "resident@test.proplane.local",
        reporterName: "Resident",
        onSubmitted: () => {},
        open: true,
        initialKind: "bug",
      }),
    );
    act(() => result.current.setMessage("The lease PDF download button is dead."));
    await act(async () => {
      await result.current.handleSubmit();
    });
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { row: Record<string, unknown> };
    expect(body.row.type).toBe("bug");
    expect(body.row.reportKind).toBe("bug");
  });

  it("shows an inline retry state on a failed submit, without losing the typed message", async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }));
    const { result } = renderHook(() =>
      usePortalFeedbackForm({
        reporterRole: "manager",
        reporterUserId: "user-1",
        reporterEmail: "manager2@test.proplane.local",
        reporterName: "Manager Two",
        onSubmitted: () => {},
        open: true,
      }),
    );
    act(() => result.current.setMessage("Testing the retry path."));
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(result.current.submitted).toBe(false);
    expect(result.current.submitError).toMatch(/Could not send/);
    expect(result.current.message).toBe("Testing the retry path.");
    expect(result.current.busy).toBe(false);
  });

  it("refuses an empty message without calling the network", async () => {
    const fetchSpy = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const { result } = renderHook(() =>
      usePortalFeedbackForm({
        reporterRole: "manager",
        reporterUserId: "user-1",
        reporterEmail: "manager2@test.proplane.local",
        reporterName: "Manager Two",
        onSubmitted: () => {},
        open: true,
      }),
    );
    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("Tell us what's on your mind.");
  });
});
