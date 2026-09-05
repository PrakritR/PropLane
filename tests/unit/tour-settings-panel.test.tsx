// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import { DEFAULT_MANAGER_TOUR_SETTINGS } from "@/lib/manager-tour-settings";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { TourSettingsPanel } from "@/components/portal/pro-portal-settings-panels";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
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
        // The panel now embeds the manager reminder-rule settings, which load
        // from their own endpoint. Unstubbed, that child stayed in "Loading…"
        // after the parent had finished, so the panel never looked loaded.
        if (url.includes("/api/portal/reminder-settings")) {
          return Response.json({ settings: {} });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<TourSettingsPanel />);

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(await screen.findByText("Notice required")).toBeTruthy();
    // The embedded reminder settings load independently, so the parent being
    // done does not mean every "Loading…" has gone. Waiting for that is the
    // assertion this test actually means; checking it synchronously raced.
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  });

  it("clears loading and toasts when automation settings are unauthorized", async () => {
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
        if (url.includes("/api/portal/reminder-settings")) {
          return Response.json({ settings: {} });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<TourSettingsPanel />);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Unauthorized."));
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.getByText("Notice required")).toBeTruthy();
  });
});
