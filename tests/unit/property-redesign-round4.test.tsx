/** @vitest-environment jsdom */
// Round 4 of the property redesign. Each block pins one fix from the captain's review.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AddWorkspace } from "@/components/portal/add-workspace";
import { ServiceOfferingEditModal } from "@/components/portal/service-offering-edit-modal";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { sharedGet, invalidateSharedGets, resetSharedGets } from "@/lib/shared-get-cache";
import { usePropertyFormSetupSettings } from "@/lib/property-form-setup-settings.client";
import { syncProRelationshipsFromServer } from "@/lib/pro-relationships";
import { syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  // Off the demo sandbox ("/" counts as one), so the portal sync helpers really fetch.
  window.history.pushState({}, "", "/portal/properties/listed/p1/lease");
  resetSharedGets();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function workspace(stepIds: Array<{ id: string; label: string; incomplete?: boolean }>, extra: { sidePanel?: boolean } = {}) {
  return render(
    <AddWorkspace
      title="Add application"
      steps={stepIds}
      current={0}
      onJump={() => {}}
      onClose={() => {}}
      assistantContext="test"
      assistantScopeKey="test"
      lastLabel="Save"
      onFinish={() => {}}
      sidePanel={extra.sidePanel ? <div>Live panel</div> : undefined}
    >
      <p>Body</p>
    </AddWorkspace>,
  );
}

/* 2 ─ no centered "Complete <step>" label in the footer */
describe("the step popup footer", () => {
  it("prints no 'Complete <step>' label, keeps 'Step N of M' for several steps, and the rail's finish chip", () => {
    workspace([
      { id: "a", label: "Application", incomplete: true },
      { id: "b", label: "Review" },
    ]);
    expect(screen.queryByText(/^Complete Application/)).toBeNull();
    expect(screen.getAllByText(/Step 1 of 2/).length).toBeGreaterThan(0);
    // The "N things to finish" chip stays at the top of the rail.
    expect(document.body.textContent).toMatch(/1 thing to finish|1 to finish|to finish/i);
  });

  it("a one-step popup shows no 'Step 1 of 1' either", () => {
    workspace([{ id: "a", label: "Service", incomplete: true }]);
    expect(screen.queryByText(/Step \d+ of \d+/)).toBeNull();
    expect(screen.queryByText(/^Complete Service/)).toBeNull();
  });
});

/* 3 ─ a rail with one item is not drawn */
describe("a one-step popup has no rail", () => {
  it("marks the workspace rail-less and hides the section nav (with its grid column) when there is one step", () => {
    workspace([{ id: "pricing", label: "Pricing" }], { sidePanel: true });
    const root = document.querySelector("[data-rail]") as HTMLElement | null;
    expect(root?.getAttribute("data-rail")).toBe("none");
    expect(root?.className).toContain("[&_nav[aria-label^=Listing]]:hidden");
    // The live panel keeps its column once the rail's 220px is gone.
    expect(root?.className).toContain("grid-cols-[minmax(0,1fr)_300px]");
  });

  it("keeps the rail when there are several steps", () => {
    workspace([
      { id: "a", label: "One" },
      { id: "b", label: "Two" },
    ]);
    expect(document.querySelector("[data-rail]")).toBeNull();
    expect(document.querySelector("nav[aria-label^=Listing]")).toBeTruthy();
  });
});

/* 4 ─ the Add service switch rows are indented like every other row */
describe("the Add service popup switch rows", () => {
  it("sit inside the card's padding like the other rows, not flush left", () => {
    const sub = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
    render(
      <ServiceOfferingEditModal
        open
        offering={null}
        isNew
        sub={sub}
        saveTarget={{ mode: "pending", saveId: "t" } as never}
        managerUserId="mgr"
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    for (const label of ["Available to request", "Needs your approval"]) {
      const text = screen.getAllByText(label).find((node) => node.tagName === "SPAN")!;
      const row = text.closest('[data-slot="toggle-fact-row"]') as HTMLElement | null;
      expect(row, label).toBeTruthy();
      expect(row!.className).toContain("px-3.5");
      expect(row!.className).toContain("min-h-[52px]");
    }
  });
});

/* 5a ─ one fetch per key per page load */
describe("shared GET cache", () => {
  function okFetch() {
    const fn = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ url }) }));
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("two concurrent readers of one key share one request", async () => {
    const fetchMock = okFetch();
    const [a, b] = await Promise.all([
      sharedGet("/api/manager/messaging-number?workspaceId=w1"),
      sharedGet("/api/manager/messaging-number?workspaceId=w1"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    // A later reader inside the TTL reuses the settled answer.
    await sharedGet("/api/manager/messaging-number?workspaceId=w1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a different workspace or property is a different key", async () => {
    const fetchMock = okFetch();
    await Promise.all([
      sharedGet("/api/manager/assistant-email?workspaceId=w1"),
      sharedGet("/api/manager/assistant-email?workspaceId=w2"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a write invalidates, and a failed read is not cached", async () => {
    const fetchMock = okFetch();
    await sharedGet("/api/portal/manager-application-settings?propertyId=p1");
    invalidateSharedGets("/api/portal/manager-application-settings");
    await sharedGet("/api/portal/manager-application-settings?propertyId=p1");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const failing = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", failing);
    expect((await sharedGet("/api/x?workspaceId=w")).ok).toBe(false);
    await sharedGet("/api/x?workspaceId=w");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("the Applications and Lease panels' form-setup hook, mounted twice for one property, sends one request", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ leasingPipeline: {}, settings: {}, waiverCode: null }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    function Reader() {
      usePropertyFormSetupSettings("prop-1");
      return null;
    }
    await act(async () => {
      render(
        <>
          <Reader />
          <Reader />
        </>,
      );
    });
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.filter((url) => url.includes("manager-application-settings?propertyId=prop-1"))).toHaveLength(1);
  });
});

/* 5b ─ a 404 from the relationships mirror is an empty read, not a retry-on-every-mount error */
describe("/api/portal-pro-relationships answering 404", () => {
  it("settles as an empty read: no console error, no refetch inside the TTL", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "Record not found." }) }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await syncProRelationshipsFromServer("rel-user-404", { force: true });
    expect(first).toEqual([]);
    const again = await syncProRelationshipsFromServer("rel-user-404");
    expect(again).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

/* 5c ─ the applications list is reused across tab changes */
describe("/api/manager-applications on the property record", () => {
  it("a longer reuse window serves later tab changes from the first read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rows: [] }), text: async () => JSON.stringify({ rows: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await syncManagerApplicationsFromServer({ managerUserId: "mgr-apps", force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-03T12:01:00Z"));
    await syncManagerApplicationsFromServer({ managerUserId: "mgr-apps", maxAgeMs: 5 * 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The default 15 s window would have re-sent the whole list.
    await syncManagerApplicationsFromServer({ managerUserId: "mgr-apps" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
