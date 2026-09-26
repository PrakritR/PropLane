// @vitest-environment jsdom
/**
 * Covers the Part 1 redraw of `TourSettingsPanel` onto the shared settings
 * kit: the notice-required stepper (real `<input type="number">` flanked by
 * −/+ buttons), the auto-confirm toggle (`role="switch"`), and that every
 * row carries a real consequence line via `PortalSettingsRow`'s `meta` prop.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import { DEFAULT_MANAGER_TOUR_SETTINGS } from "@/lib/manager-tour-settings";
import { invalidateManagerAutomationSettingsCache } from "@/lib/manager-automation-settings-client";

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

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

// The automation-settings read now goes through the shared cache
// (`manager-automation-settings-client.ts`), which is keyed on the viewer id
// this hook supplies — without it the panel's load effect no-ops forever.
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ ready: true, email: "manager@example.com", userId: "mgr-1" }),
}));

import { TourSettingsPanel } from "@/components/portal/pro-portal-settings-panels";
import { SettingsPropertyScopeProvider } from "@/components/portal/settings-property-scope";

function stubFetch(overrides?: { tourNoticeDays?: number; proposeTourConfirmations?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/portal/manager-tour-settings")) {
        if (init?.method === "PATCH") {
          return Response.json({ settings: { ...DEFAULT_MANAGER_TOUR_SETTINGS, ...overrides }, source: "account" });
        }
        return Response.json({
          settings: { ...DEFAULT_MANAGER_TOUR_SETTINGS, tourNoticeDays: overrides?.tourNoticeDays ?? 0 },
          source: "account",
        });
      }
      if (url.includes("/api/portal/automation-settings")) {
        if (init?.method === "PATCH") {
          return Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS, source: "account" });
        }
        return Response.json({
          settings: {
            ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
            proposeTourConfirmations: overrides?.proposeTourConfirmations ?? false,
          },
          source: "account",
        });
      }
      if (url.includes("/api/portal/reminder-settings")) {
        return Response.json({ settings: {}, source: "account" });
      }
      if (url.includes("/api/portal/automated-messages")) {
        return Response.json({ settings: {}, defaults: {}, source: "account" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

/** Stands in for the module host, which mounts `SettingsPropertyScopeProvider` around a panel. */
function withScope(node: ReactNode) {
  return (
    <SettingsPropertyScopeProvider
      workspaceId=""
      onWorkspaceIdChange={() => {}}
      propertyIds={[]}
      onPropertyIdsChange={() => {}}
      options={[]}
    >
      {node}
    </SettingsPropertyScopeProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
  // The shared automation-settings read cache (N032) is module-level and
  // outlives a single test's render — without dropping it, a later test's
  // mount would silently reuse an earlier test's cached value instead of
  // hitting its own stub.
  invalidateManagerAutomationSettingsCache();
});

describe("TourSettingsPanel redraw", () => {
  it("renders the notice-required stepper with an accessible name and value, and clamps at its minimum", async () => {
    stubFetch({ tourNoticeDays: 0 });
    render(withScope(<TourSettingsPanel />));
    await screen.findByText("Notice required");

    const input = screen.getByRole("spinbutton", { name: "Notice required" }) as HTMLInputElement;
    expect(input.value).toBe("0");

    const decrement = screen.getByRole("button", { name: "Decrease notice required" });
    const increment = screen.getByRole("button", { name: "Increase notice required" });

    // Clamped at its minimum already — the button is disabled and the value never goes negative.
    expect(decrement).toBeDisabled();
    await userEvent.click(decrement);
    expect(input.value).toBe("0");

    await userEvent.click(increment);
    expect(input.value).toBe("1");
    expect(decrement).not.toBeDisabled();

    await userEvent.click(increment);
    expect(input.value).toBe("2");

    await userEvent.click(decrement);
    expect(input.value).toBe("1");
  });

  it("renders auto-confirm as a switch and flips it", async () => {
    stubFetch({ proposeTourConfirmations: false });
    render(withScope(<TourSettingsPanel />));
    await screen.findByText("Notice required");

    const toggle = screen.getByRole("switch", { name: "Auto confirm tours" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("gives every settings row a label and a control, never a sentence under it", async () => {
    stubFetch();
    render(withScope(<TourSettingsPanel />));
    const notice = await screen.findByText("Notice required");
    // The label column is the label alone (AGENTS.md § No subtext).
    expect(notice.parentElement?.textContent).toBe("Notice required");
    expect(screen.queryByText(/same-day requests stay hidden/i)).toBeNull();
    expect(screen.queryByText(/without asking you first/i)).toBeNull();
  });

  it("tags Booking Account when no house is picked, now that the property/workspace picker actually feeds the panel", async () => {
    // WS4 (PLAN-0925 Part 5, C191): Reminders / Requests-and-follow-ups /
    // Messages-sent-automatically are gone from this modal — reminder timing,
    // channels and wording ship on the shipped defaults everywhere now (see
    // `WhatProplaneSends`). The one section left, Booking, is what the scope
    // picker above this panel actually reaches: fixing the bug where neither
    // fetch here read `propertyId`/`workspaceId` is what makes this tag real.
    stubFetch();
    render(withScope(<TourSettingsPanel />));
    await screen.findByText("Notice required");

    const tags = await screen.findAllByText("Account");
    expect(tags.length).toBeGreaterThanOrEqual(1);
  });
});
