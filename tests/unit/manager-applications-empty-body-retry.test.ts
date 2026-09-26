// @vitest-environment jsdom
//
// C200 — BUG: manager Applications → Pending stays empty; detail hangs.
//
// `syncManagerApplicationsFromServerWithStatus` used to call `res.json()`
// with no guard. A 200 response with an empty or malformed body makes that
// throw a SyntaxError, which the outer `.catch()` folded into the same path
// as a genuine network failure: the sync silently kept whatever (possibly
// empty) rows were already cached, with no further attempt to re-fetch. This
// pins two behaviors: the parse failure never escapes as an uncaught
// rejection, and one automatic retry recovers a transient empty response.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/auth/portal-session-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/portal-session-gate")>()),
  portalSessionEnded: () => false,
  portalSessionViewerId: () => "mgr-empty-body-retry",
}));

import { syncManagerApplicationsFromServerWithStatus } from "@/lib/manager-applications-storage";

describe("syncManagerApplicationsFromServerWithStatus — empty/malformed body", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries once and recovers rows after an empty 200 body", async () => {
    const fetchMock = vi
      .fn()
      // First GET: a 200 with an empty body — `res.json()` throws on this.
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      // Automatic retry: a real body lands.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rows: [
              {
                id: "AXIS-EMPTY-BODY-1",
                name: "Retry Recovered",
                property: "Willow House",
                propertyId: "prop-willow",
                stage: "Submitted",
                bucket: "pending",
                detail: "Submitted",
                email: "retry@example.com",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-empty-body-retry" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.rows.some((row) => row.id === "AXIS-EMPTY-BODY-1")).toBe(true);
  });

  it("falls back to a failed sync (not an uncaught rejection) when the retry also fails to parse", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not json", { status: 200 }))
      .mockResolvedValueOnce(new Response("still not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncManagerApplicationsFromServerWithStatus({ force: true, managerUserId: "mgr-empty-body-retry" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.rows)).toBe(true);
  });
});
