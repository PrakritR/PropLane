// @vitest-environment jsdom
//
// Round 5 (V1): the vendor "verify your phone" nudge is no longer a banner clipped across the top of every
// vendor page. It is ONE compact Dashboard attention row with an icon action (and Settings > Phone keeps
// its own prompt). Vendors never own a PropLane number (retired Oct 6), so the row asks them to VERIFY THEIR
// PHONE: managers text the vendor's own phone from their work number. It tracks `profiles.phone_verified_at`
// (read as `contact.phoneVerifiedAt` off /api/vendor/profile through sharedGet), never a typed phone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { resetSharedGets } from "@/lib/shared-get-cache";
import { useVendorPhoneNeedsVerification } from "@/hooks/use-vendor-phone-needs-verification";

function mockPhoneFetch(phoneVerifiedAt: string | null) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ profile: null, linked: true, contact: { phone: "+14255550199", phoneVerifiedAt } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Probe() {
  return <span data-testid="needs">{String(useVendorPhoneNeedsVerification())}</span>;
}

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("useVendorPhoneNeedsVerification - real phone-verification state", () => {
  afterEach(() => {
    cleanup();
    resetSharedGets();
    vi.unstubAllGlobals();
  });

  it("is true while the vendor's phone is not verified", async () => {
    mockPhoneFetch(null);
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId("needs").textContent).toBe("true"));
  });

  it("stays false once the phone is verified, even if a free-text business phone was never set", async () => {
    mockPhoneFetch("2026-10-06T10:00:00Z");
    const { getByTestId } = render(<Probe />);
    await new Promise((r) => setTimeout(r, 30));
    expect(getByTestId("needs").textContent).toBe("false");
  });

  it("reads the verification off the vendor profile route, never a manager route", async () => {
    const fetchMock = mockPhoneFetch(null);
    render(<Probe />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = (fetchMock.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(urls).toEqual(["/api/vendor/profile"]);
  });

  it("clears right after the phone is verified in Settings", async () => {
    mockPhoneFetch(null);
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId("needs").textContent).toBe("true"));
    mockPhoneFetch("2026-10-07T10:00:00Z");
    window.dispatchEvent(new Event("proplane:phone-verified"));
    await waitFor(() => expect(getByTestId("needs").textContent).toBe("false"));
  });
});

describe("the nudge lives on the Dashboard only", () => {
  it("the vendor layout mounts no per-page banner", () => {
    expect(read("src/app/vendor/layout.tsx")).not.toContain("MessagingSetupBanner");
  });

  it("the Dashboard adds one compact attention row with an icon action to Settings > Messaging", () => {
    const dashboard = read("src/components/portal/vendor-dashboard.tsx");
    expect(dashboard).toContain("useVendorPhoneNeedsVerification");
    expect(dashboard).toContain('actionLabel: "Verify phone"');
    expect(dashboard).toContain("iconAction: true");
    expect(dashboard).toContain("/profile?tab=messaging");
  });
});
