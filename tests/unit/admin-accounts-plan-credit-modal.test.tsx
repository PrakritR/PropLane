// @vitest-environment jsdom
/**
 * The global "Plan credit" table (S27) used to live behind the unreachable
 * `/admin/billing` route. It now mounts on the real Accounts surface
 * (`AdminAxisUsersClient`) behind a header icon action that opens it in a
 * modal — this covers that wiring, following the render-and-interact pattern
 * `tests/unit/admin-events-decline.test.tsx` uses for other admin clients.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/admin/axis-users",
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
  DEMO_MANAGER_USER_ID: "demo-manager",
}));

const PLAN_CREDIT_RULES = [
  { tier: "free", includedCents: 0, sharedAcrossWorkspaces: false, rollsOver: false, updatedAt: "2026-01-01T00:00:00.000Z" },
  { tier: "pro", includedCents: 500, sharedAcrossWorkspaces: true, rollsOver: true, updatedAt: "2026-01-01T00:00:00.000Z" },
  { tier: "business", includedCents: 2000, sharedAcrossWorkspaces: true, rollsOver: true, updatedAt: "2026-01-01T00:00:00.000Z" },
];

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/admin/comms-plan-credit-rules")) return jsonResponse({ rules: PLAN_CREDIT_RULES });
      if (url.includes("/api/admin/manager-billing")) return jsonResponse({ rows: [] });
      if (url.includes("/api/admin/managers")) return jsonResponse({ managers: [] });
      if (url.includes("/api/admin/residents")) return jsonResponse({ residents: [] });
      if (url.includes("/api/admin/vendors")) return jsonResponse({ vendors: [] });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

import { AdminAxisUsersClient } from "@/components/portal/admin-axis-users-client";

describe("AdminAxisUsersClient Plan credit", () => {
  it("renders a Plan credit header icon action on the Accounts list", async () => {
    render(<AdminAxisUsersClient />);
    const openButton = await screen.findByRole("button", { name: "Plan credit" });
    // Utility chrome is an icon action, never a labeled pill (AGENTS.md "Portal
    // UI system" — icon chrome): no visible "Plan credit" text on the button
    // itself, only the accessible name / tooltip.
    expect(openButton).toHaveAttribute("aria-label", "Plan credit");
    expect(openButton).toHaveAttribute("aria-label", "Plan credit");
    expect(openButton.textContent?.trim()).toBe("");
  });

  it("opens the plan credit rows in a modal when the header action is clicked", async () => {
    render(<AdminAxisUsersClient />);
    const openButton = await screen.findByRole("button", { name: "Plan credit" });

    fireEvent.click(openButton);

    // The plan credit table's per-tier rows load from the same
    // /api/admin/comms-plan-credit-rules route the retired /admin/billing page used.
    expect(await screen.findByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Business")).toBeInTheDocument();
    expect(screen.getByText("Included/mo")).toBeInTheDocument();
    expect(screen.getByText("Shared across workspaces")).toBeInTheDocument();
    expect(screen.getByText("Unused rolls over")).toBeInTheDocument();
  });

  it("closes the modal from its header close control", async () => {
    render(<AdminAxisUsersClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan credit" }));
    await screen.findByText("Free");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByText("Included/mo")).not.toBeInTheDocument());
  });
});
