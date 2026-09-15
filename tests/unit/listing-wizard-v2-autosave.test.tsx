// @vitest-environment jsdom
//
// The v2 editor writes when the manager hits X. There is no Save & exit.
// An untouched new listing writes nothing. A live edit writes in place.
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

import { LISTING_DRAFT_AUTOSAVE_DEBOUNCE_MS } from "@/lib/manager-listing-draft-autosave";
import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";

afterEach(() => {
  cleanup();
  saveManagerPropertyDraftToServer.mockClear();
  updateExtraListingFromSubmissionOnServer.mockClear();
});

describe("listing wizard v2 autosave", () => {
  it("does not write an untouched new listing on close", async () => {
    const onClose = vi.fn();
    render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" />);
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
  });

  it("flushes a dirty draft on X", async () => {
    const onClose = vi.fn();
    render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" />);
    fireEvent.change(screen.getByPlaceholderText("Magnolia House"), {
      target: { value: "Cards QA house" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(saveManagerPropertyDraftToServer).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("flushes a dirty live edit on X without forking a draft", async () => {
    const onClose = vi.fn();
    const initial = { ...createDefaultListingSubmission(), buildingName: "Ash Flats" };
    render(
      <ListingWizardV2
        onClose={onClose}
        userId="mgr-1"
        skuTier="starter"
        editListingId="mgr-ash"
        editListingOwnerUserId="mgr-1"
        initialSubmission={initial}
      />,
    );
    fireEvent.change(screen.getByDisplayValue("Ash Flats"), { target: { value: "Ash Flats 6" } });
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(updateExtraListingFromSubmissionOnServer).toHaveBeenCalled());
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("autosave keeps the section the manager is on", async () => {
    render(<ListingWizardV2 onClose={() => {}} userId="mgr-1" skuTier="starter" />);
    fireEvent.change(screen.getByPlaceholderText("Magnolia House"), {
      target: { value: "Cards QA house" },
    });
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
    await waitFor(
      () => expect(saveManagerPropertyDraftToServer).toHaveBeenCalled(),
      { timeout: LISTING_DRAFT_AUTOSAVE_DEBOUNCE_MS + 2000 },
    );
    const opts = saveManagerPropertyDraftToServer.mock.calls.at(-1)?.[2] as { stepIndex?: number };
    expect(opts.stepIndex).toBe(1);
  });
});
