// @vitest-environment jsdom
//
// Withdrawal finality, client side: `confirmWithdraw` cancels any queued
// (debounced, not-yet-sent) autosave for the withdrawn application id via
// `cancelPendingApplicationRowUpsert`, so a pre-withdraw snapshot is neither
// flushed by the debounce timer nor beaconed by the pagehide unload flush —
// either would ask the server to re-store the row the resident just withdrew.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import {
  cancelPendingApplicationRowUpsert,
  upsertApplicationRowToServer,
} from "@/lib/manager-applications-storage";

function appRow(id: string): DemoApplicantRow {
  return {
    id,
    name: "Jamie Rivera",
    property: "Willow House",
    propertyId: "prop-willow",
    stage: "In progress",
    bucket: "pending",
    detail: "Started now",
    email: "jamie.rivera@example.com",
  };
}

const fetchMock = vi.fn((_input?: unknown, _init?: RequestInit) =>
  Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
);

describe("cancelPendingApplicationRowUpsert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("drops a queued autosave so the debounce timer never sends it", async () => {
    upsertApplicationRowToServer(appRow("AXIS-CANCEL-1"));
    cancelPendingApplicationRowUpsert("AXIS-CANCEL-1");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the snapshot the pagehide unload flush would beacon", async () => {
    upsertApplicationRowToServer(appRow("AXIS-CANCEL-2"));
    cancelPendingApplicationRowUpsert("AXIS-CANCEL-2");
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves other applications' queued autosaves untouched", async () => {
    upsertApplicationRowToServer(appRow("AXIS-CANCEL-3"));
    upsertApplicationRowToServer(appRow("AXIS-KEEP-1"));
    cancelPendingApplicationRowUpsert("AXIS-CANCEL-3");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as {
      row?: { id?: string };
    };
    expect(body.row?.id).toBe("AXIS-KEEP-1");
  });
});
