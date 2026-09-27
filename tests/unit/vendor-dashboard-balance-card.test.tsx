// @vitest-environment jsdom
//
// captain (studio, 2026-09-27): the vendor Dashboard drops its own
// "Not set up · Work phone" / "Not set up · Work email" setup rows (that
// notice lives in the top banner only now) and gains a Balance card with a
// top-right Withdraw icon, reusing the same balance/payout data source and
// withdraw flow as the vendor Payments page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false, DEMO_MANAGER_USER_ID: "demo-manager" }));

vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders-changed",
  readVendorWorkOrderRows: () => [],
  syncManagerWorkOrdersFromServer: () => Promise.resolve(),
}));

vi.mock("@/lib/portal-inbox-storage", () => ({
  PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
  VENDOR_INBOX_STORAGE_KEY: "vendor-inbox",
  loadPersistedInbox: () => [],
  syncPersistedInboxFromServer: () => Promise.resolve(),
}));

vi.mock("@/lib/pending-notice", () => ({
  takePendingNotice: () => null,
  VENDOR_PORTAL_PATH: "/vendor",
}));

import { VendorDashboard } from "@/components/portal/vendor-dashboard";

const readyBalance = {
  currency: "usd",
  availableCents: 5_000,
  withdrawableCents: 5_000,
  heldCents: 0,
  instantAvailableCents: 0,
  pendingCents: 0,
  onTheWayCents: 1_200,
  bank: { last4: "4421", bankName: "Chase", accountType: "checking", instantEligible: true, verifiedAt: "2026-09-12T00:00:00.000Z" },
  schedule: { interval: "weekly", nextPayoutAt: null },
  setup: { identity: "done", bank: "done", ready: true },
  history: [],
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/vendor/profile")) {
        return { ok: true, json: async () => ({ linked: true, contact: { phone: "+12065550142", smsConsent: true } }) };
      }
      if (url.includes("/api/vendor/business-profile")) {
        return { ok: true, json: async () => ({ profile: null }) };
      }
      if (url.includes("/api/vendor/stripe-connect/status")) {
        return { ok: true, json: async () => ({ paymentReady: true }) };
      }
      if (url.includes("/api/vendor/payouts/balance")) {
        return { ok: true, json: async () => readyBalance };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Vendor dashboard — no inline contact setup rows, Balance card instead", () => {
  it("never renders a Work phone / Work email setup row (that notice lives in the top banner only)", async () => {
    stubFetch();
    render(<VendorDashboard displayName="Test Vendor" />);
    await waitFor(() => expect(screen.getByText("$50.00")).toBeTruthy());
    expect(screen.queryByText("Set up work number")).toBeNull();
    expect(screen.queryByText("Set up work email")).toBeNull();
    expect(screen.queryByText("Work phone")).toBeNull();
    expect(screen.queryByText("Work email")).toBeNull();
  });

  it("renders the Balance card with the available amount, pending, and a Withdraw icon action", async () => {
    stubFetch();
    render(<VendorDashboard displayName="Test Vendor" />);
    await waitFor(() => expect(screen.getByText("$50.00")).toBeTruthy());
    expect(screen.getByText("Balance")).toBeInTheDocument();
    expect(screen.getByText("$12.00 pending")).toBeInTheDocument();
    const withdraw = screen.getByRole("button", { name: "Withdraw" });
    expect(withdraw).not.toBeDisabled();
    expect(document.querySelector('[data-attr="vendor-dashboard-balance"]')).toBeTruthy();
  });
});
