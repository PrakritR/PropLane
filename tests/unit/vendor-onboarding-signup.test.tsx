// @vitest-environment jsdom
//
// Captain 2026-09-27 (VD20, studio): the vendor Dashboard's "waiting on a
// property manager" banner and its dismiss control are gone — an unlinked
// vendor no longer sees any signup-status banner on Dashboard. This locks
// that removal in place; the STATE-driven design this used to guard
// (docs/agents/vendor-portal.md, night/vendor-signup) is retired with it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

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

import { VendorDashboard } from "@/components/portal/vendor-dashboard";

function mockFetchWith(linked: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/vendor/profile")) {
        return { ok: true, json: async () => ({ linked, contact: { phone: "", smsConsent: false } }) };
      }
      if (url.includes("/api/vendor/business-profile")) {
        return { ok: true, json: async () => ({ profile: null }) };
      }
      if (url.includes("/api/vendor/stripe-connect/status")) {
        return { ok: true, json: async () => ({ paymentReady: false }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

describe("Vendor dashboard — no signup-status banner (VD20, 2026-09-27)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("never renders the waiting-on-a-manager banner or its dismiss control, unlinked or linked", async () => {
    mockFetchWith(false);
    render(<VendorDashboard displayName="Test Vendor" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText("Waiting on a property manager to connect with you.")).toBeNull();
    expect(document.querySelector('[data-attr="vendor-signup-notice-dismiss"]')).toBeNull();

    cleanup();
    mockFetchWith(true);
    render(<VendorDashboard displayName="Test Vendor" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText("Waiting on a property manager to connect with you.")).toBeNull();
  });

  it("never renders the Finish setting up onboarding checklist", async () => {
    mockFetchWith(false);
    render(<VendorDashboard displayName="Test Vendor" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText("Finish setting up")).toBeNull();
    expect(document.querySelector('[data-attr="vendor-onboarding-checklist"]')).toBeNull();
  });

  it("labels the jobs section Services, not Your jobs", async () => {
    mockFetchWith(true);
    render(<VendorDashboard displayName="Test Vendor" />);
    await waitFor(() => expect(screen.getByText("Services")).toBeTruthy());
    expect(screen.queryByText("Your jobs")).toBeNull();
  });
});
