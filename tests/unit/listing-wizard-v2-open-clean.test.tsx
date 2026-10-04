// @vitest-environment jsdom
//
// Opening a saved listing shows the counts its lists add up to and leaves it "Saved": the stored
// counters are rewritten only when the manager edits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const saveManagerPropertyDraftToServer = vi.hoisted(() => vi.fn(async () => "mgr-draft-1"));
const updateExtraListingFromSubmissionOnServer = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer,
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  submitManagerPendingPropertyToServer: vi.fn(),
  updateExtraListingFromSubmissionOnServer,
}));
vi.mock("@/lib/native/app-review", () => ({
  recordDelightMoment: vi.fn(),
}));
vi.mock("@/lib/manager-subscription-client", () => ({
  loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false),
}));
vi.mock("@/lib/prepare-listing-submission-for-persist", () => ({
  prepareListingSubmissionForPersist: vi.fn(async (sub: unknown) => ({
    submission: sub,
    droppedMediaCount: 0,
  })),
  listingSaveFailureMessage: (reason: string) => reason || "Could not save.",
}));
vi.mock("@/lib/analytics/track-client", () => ({
  track: vi.fn(),
}));
vi.mock("@/lib/native/detect-native", () => ({
  isNativeRuntimeSync: vi.fn(() => false),
}));

import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import { emptyBathroom, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

afterEach(() => {
  cleanup();
  saveManagerPropertyDraftToServer.mockClear();
  updateExtraListingFromSubmissionOnServer.mockClear();
});

/** Stored counts that disagree with the lists: 1 bathroom / 1 floor on disk, 3 bathrooms and a 3rd-floor room. */
function staleSaved(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const bath = (n: number) => ({ ...emptyBathroom(n), id: `b${n}`, name: `Bathroom ${n + 1}`, bathtub: true });
  return {
    ...base,
    buildingName: "Magnolia House",
    listingTotalBathroomsId: "1",
    listingStoriesId: "1",
    rooms: [{ ...base.rooms[0]!, floor: "3rd floor" }],
    bathrooms: [bath(0), bath(1), bath(2)],
  };
}

describe("opening a saved listing", () => {
  it("shows the derived Bathrooms and Floors, stays 'Saved', and writes nothing by itself", async () => {
    const onClose = vi.fn();
    render(
      <ListingWizardV2
        onClose={onClose}
        userId="mgr-1"
        skuTier="starter"
        editListingId="mgr-magnolia"
        editListingOwnerUserId="mgr-1"
        initialSubmission={staleSaved()}
      />,
    );
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-basics"]')!);
    expect(document.body.textContent).toContain("Saved");
    expect(document.body.textContent).not.toContain("Unsaved changes");
    expect(document.querySelector('[data-attr="listing-v2-bathrooms"]')!.textContent).toContain("3");
    expect(document.querySelector('[data-attr="listing-v2-floors"]')!.textContent).toContain("3");
    // closing with no edit writes nothing
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateExtraListingFromSubmissionOnServer).not.toHaveBeenCalled();
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
  });
});
