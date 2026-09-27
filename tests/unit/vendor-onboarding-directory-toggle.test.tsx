// @vitest-environment jsdom
//
// Proof finding (HIGH): "List me in the PropLane vendor directory" defaulted
// to OFF for every real self-serve signup, because a not-yet-onboarded
// profile reads back `directoryListed: false` (the DB column's safety
// default, or the EMPTY fallback shape when no row exists yet) rather than
// null/undefined — so the old `?? true` fallback never applied. Fixed in
// src/components/portal/vendor-onboarding.tsx: show ON while
// onboarding_completed_at is null, respect the saved value once it's set.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

import { VendorOnboardingFlow } from "@/components/portal/vendor-onboarding";

function mockProfileFetch(profile: Record<string, unknown> | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ profile }) })),
  );
}

const EMPTY_PROFILE_ROW = {
  businessName: "",
  serviceArea: "",
  trades: [] as string[],
  serviceAreaZips: [] as string[],
  serviceRadiusMiles: null,
  licenseNumber: "",
  licenseDocPath: null,
  insuranceProvider: "",
  insurancePolicyNumber: "",
  insuranceExpiresAt: null,
  insuranceDocPath: null,
  onboardingCompletedAt: null,
};

describe("vendor onboarding directory-listed toggle — defaults ON until onboarding completes", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the toggle checked for a brand-new profile that reads back directoryListed:false and onboardingCompletedAt:null", async () => {
    mockProfileFetch({ ...EMPTY_PROFILE_ROW, directoryListed: false });
    render(<VendorOnboardingFlow />);
    await waitFor(() => {
      const toggle = document.querySelector('[data-attr="vendor-onboarding-directory-toggle"]') as HTMLInputElement | null;
      expect(toggle).toBeTruthy();
      expect(toggle?.checked).toBe(true);
    });
  });

  it("still shows ON for a mid-onboarding profile (some fields saved, still not complete)", async () => {
    mockProfileFetch({ ...EMPTY_PROFILE_ROW, businessName: "Apex", directoryListed: false, onboardingCompletedAt: null });
    render(<VendorOnboardingFlow />);
    await waitFor(() => {
      const toggle = document.querySelector('[data-attr="vendor-onboarding-directory-toggle"]') as HTMLInputElement | null;
      expect(toggle?.checked).toBe(true);
    });
  });

  it("respects the persisted value once onboarding has actually completed", async () => {
    mockProfileFetch({
      ...EMPTY_PROFILE_ROW,
      businessName: "Apex",
      trades: ["Plumbing"],
      serviceArea: "Seattle, WA",
      directoryListed: false,
      onboardingCompletedAt: "2026-09-25T00:00:00.000Z",
    });
    render(<VendorOnboardingFlow />);
    await waitFor(() => {
      const toggle = document.querySelector('[data-attr="vendor-onboarding-directory-toggle"]') as HTMLInputElement | null;
      expect(toggle?.checked).toBe(false);
    });
  });
});
