// @vitest-environment jsdom
/**
 * There is no separate anonymous "sign the lease first" flow — a lease-first
 * listing (`property.signingOrder`, PLAN-0927) reuses the same apply wizard,
 * so step 1 must say so up front, before anything is filled in. This is the
 * signed-in-resident / resumed-link path into the wizard itself; the
 * anonymous prospect's actual first screen (the account-creation gate) is
 * covered separately in `public-apply-account-prompt.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
vi.mock("next/navigation", () => ({
  usePathname: () => "/rent/apply",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";

const PID_LEASE_FIRST = "mgr-banner-lease-first";
const PID_APPLICATION_FIRST = "mgr-banner-application-first";

function seedProperty(id: string, signingOrder?: "application_first" | "lease_first"): void {
  const sub = createDefaultListingSubmission();
  const property: MockProperty = {
    id,
    title: "Banner Test House",
    tagline: "Test",
    address: "1 Banner St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Banner Test House",
    unitLabel: "Unit 1",
    adminPublishLive: true,
    managerUserId: "mgr-banner-owner",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
    ...(signingOrder ? { signingOrder } : {}),
  };
  cachePublicExtraListings([property], { silent: true });
}

afterEach(async () => {
  await act(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.restoreAllMocks();
});

describe("rental wizard step 1 — lease-first banner", () => {
  it("shows the lease-first banner when the linked property's signingOrder is lease_first", async () => {
    seedProperty(PID_LEASE_FIRST, "lease_first");
    await act(async () => {
      render(
        <RentalApplicationWizard
          showToast={() => {}}
          mode="manager"
          layout="embedded"
          linkedPropertyId={PID_LEASE_FIRST}
        />,
      );
    });
    expect(screen.getByText("Signing the lease comes first")).toBeTruthy();
    expect(screen.getByText(/sign the lease first, then finish your household application/i)).toBeTruthy();
  });

  it("shows no banner for an application-first listing (today's screen, unchanged)", async () => {
    seedProperty(PID_APPLICATION_FIRST, "application_first");
    await act(async () => {
      render(
        <RentalApplicationWizard
          showToast={() => {}}
          mode="manager"
          layout="embedded"
          linkedPropertyId={PID_APPLICATION_FIRST}
        />,
      );
    });
    expect(screen.queryByText("Signing the lease comes first")).toBeNull();
  });

  it("shows no banner when signingOrder is absent — every existing caller keeps compiling unchanged", async () => {
    seedProperty(PID_APPLICATION_FIRST);
    await act(async () => {
      render(
        <RentalApplicationWizard
          showToast={() => {}}
          mode="manager"
          layout="embedded"
          linkedPropertyId={PID_APPLICATION_FIRST}
        />,
      );
    });
    expect(screen.queryByText("Signing the lease comes first")).toBeNull();
  });
});
