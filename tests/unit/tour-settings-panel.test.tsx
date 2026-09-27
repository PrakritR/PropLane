// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import { DEFAULT_MANAGER_TOUR_SETTINGS } from "@/lib/manager-tour-settings";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast }),
}));

// The automation-settings read now goes through the shared cache
// (`manager-automation-settings-client.ts`), which is keyed on the viewer id
// this hook supplies — without it the panel's load effect no-ops forever.
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ ready: true, email: "manager@example.com", userId: "mgr-1" }),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { TourSettingsPanel } from "@/components/portal/pro-portal-settings-panels";
import { invalidateManagerAutomationSettingsCache } from "@/lib/manager-automation-settings-client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
  // The shared read cache (N032) is module-level and outlives a single test's
  // render — without dropping it, the second test's mount would silently
  // reuse the first test's cached (successful) automation-settings value
  // instead of hitting its own 401 stub.
  invalidateManagerAutomationSettingsCache();
});

describe("TourSettingsPanel", () => {
  it("leaves the loading state after tour and automation settings load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/portal/manager-tour-settings")) {
          return Response.json({ settings: { tourNoticeDays: 1 } });
        }
        if (url.includes("/api/portal/automation-settings")) {
          return Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<TourSettingsPanel />);

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(await screen.findByText("Notice required")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  });

  it("shows the load error with a retry, not a bare toast, when automation settings are unauthorized", async () => {
    // WS4 (PLAN-0925 Part 5, C191): the panel used to toast the error and
    // still render the form on whatever partial state it had — now it shows
    // the same inline error + retry shape as `ManagerPortalAutomationSettingsPanel`
    // ("the Reminders panel next to it"), so a failed load is never silently
    // half-rendered.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/portal/manager-tour-settings")) {
          return Response.json({ settings: DEFAULT_MANAGER_TOUR_SETTINGS });
        }
        if (url.includes("/api/portal/automation-settings")) {
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<TourSettingsPanel />);

    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(await screen.findByText("Unauthorized.")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.queryByText("Notice required")).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });
});
