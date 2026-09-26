// @vitest-environment jsdom
//
// Night build (night/vendor-signup): locks in the fix for the documented bug
// in docs/agents/vendor-portal.md — the vendor Dashboard's unlinked banner
// must be STATE-driven (render whenever the vendor has no linked manager),
// not delivery-driven off a one-shot sessionStorage notice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Simulates the exact old bug: no pending notice was ever queued for this
// page load (e.g. the vendor arrived via the email-confirmation link, which
// docs/agents/vendor-portal.md calls out as never queuing one).
const takePendingNotice = vi.fn(() => null);
vi.mock("@/lib/pending-notice", () => ({
  takePendingNotice: (...args: unknown[]) => takePendingNotice(...args),
  VENDOR_PORTAL_PATH: "/vendor",
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

describe("Vendor dashboard unlinked banner — state-driven, not delivery-driven", () => {
  beforeEach(() => {
    takePendingNotice.mockReturnValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the unlinked banner from live /api/vendor/profile state even when no notice was queued this page load", async () => {
    mockFetchWith(false);
    render(<VendorDashboard displayName="Test Vendor" />);
    await waitFor(() =>
      expect(screen.getByText("Waiting on a property manager to connect with you.")).toBeTruthy(),
    );
    expect(document.querySelector('[data-attr="vendor-signup-notice-dismiss"]')).toBeTruthy();
  });

  it("never shows the banner once the vendor is linked", async () => {
    mockFetchWith(true);
    render(<VendorDashboard displayName="Test Vendor" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText("Waiting on a property manager to connect with you.")).toBeNull();
    expect(document.querySelector('[data-attr="vendor-signup-notice-dismiss"]')).toBeNull();
  });

  it("prefers the queued signup reason over the generic copy when both are present", async () => {
    takePendingNotice.mockReturnValue("Your invite link expired.");
    mockFetchWith(false);
    render(<VendorDashboard displayName="Test Vendor" />);
    await waitFor(() => expect(screen.getByText("Your invite link expired.")).toBeTruthy());
  });
});
