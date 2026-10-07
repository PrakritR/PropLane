// @vitest-environment jsdom
//
// The shared vendor notice shows on EVERY vendor page, not just
// Communication/Settings. Vendors never own a PropLane number (retired Oct 6),
// so it asks them to VERIFY THEIR PHONE: managers text the vendor's own phone
// from their work number, and those conversations (earlier ones included) link
// once the phone is verified with a code. It tracks `profiles.phone_verified_at`
// (read as `contact.phoneVerifiedAt` off /api/vendor/profile through sharedGet), never a typed phone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { resetSharedGets } from "@/lib/shared-get-cache";
import { VendorMessagingSetupBanner } from "@/components/portal/vendor-messaging-setup-banner";

function mockPhoneFetch(phoneVerifiedAt: string | null) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ profile: null, linked: true, contact: { phone: "+14255550199", phoneVerifiedAt } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("VendorMessagingSetupBanner - every tab, real phone-verification state", () => {
  afterEach(() => {
    cleanup();
    resetSharedGets();
    vi.unstubAllGlobals();
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("shows while the vendor's phone is not verified", async () => {
    mockPhoneFetch(null);
    render(<VendorMessagingSetupBanner />);
    await waitFor(() => {
      expect(document.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeTruthy();
    });
    expect(document.body.textContent).toContain("Verify your phone");
  });

  it("disappears once the phone is verified, even if a free-text business phone was never set", async () => {
    mockPhoneFetch("2026-10-06T10:00:00Z");
    render(<VendorMessagingSetupBanner />);
    await waitFor(() => {
      expect(document.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeNull();
    });
  });

  it("reads the verification off the vendor profile route, never a manager route", async () => {
    const fetchMock = mockPhoneFetch(null);
    render(<VendorMessagingSetupBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = (fetchMock.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(urls).toEqual(["/api/vendor/profile"]);
  });

  it("makes no request at all once dismissed", async () => {
    window.localStorage.setItem("proplane.vendor-verify-phone-notice.dismissed", "1");
    const fetchMock = mockPhoneFetch(null);
    render(<VendorMessagingSetupBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hides right after the phone is verified in Settings", async () => {
    const fetchMock = mockPhoneFetch(null);
    render(<VendorMessagingSetupBanner />);
    await waitFor(() => expect(document.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeTruthy());
    mockPhoneFetch("2026-10-07T10:00:00Z");
    window.dispatchEvent(new Event("proplane:phone-verified"));
    await waitFor(() => expect(document.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("links Verify phone directly to Settings > Messaging", async () => {
    mockPhoneFetch(null);
    render(<VendorMessagingSetupBanner />);
    await waitFor(() => {
      const link = document.querySelector('[data-attr="vendor-messaging-setup-banner-link"]') as HTMLAnchorElement | null;
      expect(link?.getAttribute("href")).toBe("/vendor/profile?tab=messaging");
    });
  });

  it("stays dismissed once dismissed", async () => {
    mockPhoneFetch(null);
    const { findByLabelText, container } = render(<VendorMessagingSetupBanner />);
    (await findByLabelText("Dismiss")).click();
    await waitFor(() => expect(container.querySelector('[data-attr="vendor-messaging-setup-banner"]')).toBeNull());
  });
});
