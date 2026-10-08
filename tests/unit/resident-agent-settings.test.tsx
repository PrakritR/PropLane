// @vitest-environment jsdom
// Resident Settings > PropLane agent: labels only. Not subscribed -> Subscribe; subscribed -> number, plan, credit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/resident/profile" }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

import { ResidentAgentSettings, type ResidentAgentSnapshot } from "@/components/portal/resident-agent-settings";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base: ResidentAgentSnapshot = { enabled: true, priceCents: 500, subscription: null, credit: { totalCents: 0, includedCents: 0, purchasedCents: 0 } };

describe("ResidentAgentSettings", () => {
  it("not subscribed: one Subscribe row that starts the resident checkout and nothing else", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, url: "about:blank#checkout" }) });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<ResidentAgentSettings snapshot={base} reload={async () => undefined} />);
    expect(screen.getByText("Your own PropLane agent · $5 / month")).toBeTruthy();
    expect(screen.queryByText("Buy credit")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/number-subscription/checkout");
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ role: "resident", returnPath: "/resident/profile?tab=agent" });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("about:blank#checkout"));
  });

  it("subscribed: the number, the plan with Manage, and the credit with Buy credit", () => {
    render(
      <ResidentAgentSettings
        snapshot={{
          ...base,
          subscription: { status: "active", currentPeriodEnd: "2026-11-08T00:00:00Z", cancelAtPeriodEnd: false },
          credit: { totalCents: 241, includedCents: 241, purchasedCents: 0 },
          number: { state: "ready", phoneNumber: "+12065550177", sendReady: true },
          phoneVerified: true,
        }}
        reload={async () => undefined}
      />,
    );
    expect(screen.getByText("Number")).toBeTruthy();
    expect(screen.getByText(/555-0177/)).toBeTruthy();
    expect(screen.getByLabelText("Copy number")).toBeTruthy();
    expect(screen.getByText("PropLane Number · $5 / month")).toBeTruthy();
    expect(screen.getByLabelText("Manage plan")).toBeTruthy();
    expect(screen.getByText("Credit · $2.41")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buy credit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();
  });

  it("subscribed with no number yet: asks to verify the phone, or offers Get my number", () => {
    const sub = { status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false };
    const { rerender } = render(<ResidentAgentSettings snapshot={{ ...base, subscription: sub, number: { state: "none", phoneNumber: null, sendReady: false }, phoneVerified: false }} reload={async () => undefined} />);
    expect(screen.getByText("Verify your phone to get one")).toBeTruthy();
    rerender(<ResidentAgentSettings snapshot={{ ...base, subscription: sub, number: { state: "none", phoneNumber: null, sendReady: false }, phoneVerified: true }} reload={async () => undefined} />);
    expect(screen.getByRole("button", { name: "Get my number" })).toBeTruthy();
  });
});
