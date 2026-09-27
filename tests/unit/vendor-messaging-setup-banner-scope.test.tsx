// @vitest-environment jsdom
//
// VD06/VD07 (studio VD60/VD61): the shared vendor "Phone number not set up"
// banner shows on EVERY vendor page, not just Communication/Settings, and it
// tracks the real, free, PropLane-provisioned work number
// (/api/vendor/work-identity) rather than the vendor's own free-text
// profiles.phone — claiming a number is what clears it everywhere.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { VendorMessagingSetupBanner } from "@/components/portal/vendor-messaging-setup-banner";

function mockWorkIdentityFetch(smsValue: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ identity: { sms: { value: smsValue }, email: { value: null } } }),
    })),
  );
}

describe("VendorMessagingSetupBanner — every tab, real work-identity state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("shows when no sponsored work number has been claimed yet", async () => {
    mockWorkIdentityFetch(null);
    render(<VendorMessagingSetupBanner />);
    await waitFor(() => {
      expect(document.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeTruthy();
    });
  });

  it("disappears once the sponsored work number is claimed, even if a free-text profile phone was never set", async () => {
    mockWorkIdentityFetch("+12065550142");
    render(<VendorMessagingSetupBanner />);
    await waitFor(() => {
      expect(document.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeNull();
    });
  });

  it("links Set up messaging directly to the merged Work number & email tab", async () => {
    mockWorkIdentityFetch(null);
    render(<VendorMessagingSetupBanner />);
    await waitFor(() => {
      const link = document.querySelector('[data-attr="vendor-messaging-setup-banner-link"]') as HTMLAnchorElement | null;
      expect(link?.getAttribute("href")).toBe("/vendor/profile?tab=work");
    });
  });

  it("stays dismissed after the dismiss button is clicked, independent of route", async () => {
    mockWorkIdentityFetch(null);
    const { unmount } = render(<VendorMessagingSetupBanner />);
    await waitFor(() => {
      expect(document.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeTruthy();
    });
    const dismiss = document.querySelector('[data-attr="vendor-messaging-setup-banner-dismiss"]') as HTMLButtonElement;
    dismiss.click();
    await waitFor(() => {
      expect(document.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeNull();
    });
    unmount();
    render(<VendorMessagingSetupBanner />);
    await waitFor(() => {
      expect(document.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeNull();
    });
  });
});
