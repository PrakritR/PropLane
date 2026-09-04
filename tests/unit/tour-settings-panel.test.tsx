// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import { DEFAULT_MANAGER_TOUR_SETTINGS } from "@/lib/manager-tour-settings";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
}));

import { TourSettingsPanel } from "@/components/portal/manager-portal-settings-panels";

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
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<TourSettingsPanel />);

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(await screen.findByText("Notice required")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
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
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<TourSettingsPanel />);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Unauthorized."));
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("Notice required")).toBeTruthy();
  });
});
