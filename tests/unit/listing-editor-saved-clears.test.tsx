// @vitest-environment jsdom
// After a successful save the "Unsaved changes" indicator clears even when the save normalizes the submission.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const saveDraft = vi.hoisted(() => vi.fn(async () => "mgr-draft-1"));
vi.mock("@/lib/demo-admin-property-inventory", () => ({ publishManagerPropertyDraftToServer: vi.fn(), saveManagerPropertyDraftToServer: saveDraft }));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn(), updateExtraListingFromSubmissionOnServer: vi.fn(async () => true) }));
vi.mock("@/lib/native/app-review", () => ({ recordDelightMoment: vi.fn() }));
vi.mock("@/lib/manager-subscription-client", () => ({ loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false) }));
// The prepare step normalizes: it trims and appends a marker, so prepared !== raw.
vi.mock("@/lib/prepare-listing-submission-for-persist", () => ({
  prepareListingSubmissionForPersist: vi.fn(async (sub: { buildingName: string }) => ({
    submission: { ...sub, buildingName: `${sub.buildingName.trim()}` , description: "normalized" },
    droppedMediaCount: 0,
  })),
  listingSaveFailureMessage: (reason: string) => reason || "Could not save.",
}));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: vi.fn(() => false) }));

import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";

afterEach(() => {
  cleanup();
  saveDraft.mockClear();
});

describe("saved state after a normalizing save", () => {
  it("shows Unsaved changes after typing, then clears once the save lands", async () => {
    const flushRef = { current: null as null | (() => Promise<boolean>) };
    render(<ListingWizardV2 onClose={vi.fn()} userId="mgr-1" skuTier="starter" flushRef={flushRef} />);
    fireEvent.change(screen.getByPlaceholderText("Magnolia House"), { target: { value: "Maple House" } });
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    await flushRef.current!();
    await waitFor(() => expect(saveDraft).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  });
});
