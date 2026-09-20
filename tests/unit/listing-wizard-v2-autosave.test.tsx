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
vi.mock("@/lib/analytics/track-client", () => ({
  track: vi.fn(),
}));
vi.mock("@/lib/native/detect-native", () => ({
  isNativeRuntimeSync: vi.fn(() => false),
}));

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

  it("does not write on a typing timer; close keeps the section the manager is on", async () => {
    const onClose = vi.fn();
    render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" />);
    fireEvent.change(screen.getByPlaceholderText("Magnolia House"), {
      target: { value: "Cards QA house" },
    });
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-rooms"]')!);
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(saveManagerPropertyDraftToServer).toHaveBeenCalled());
    const opts = saveManagerPropertyDraftToServer.mock.calls.at(-1)?.[2] as { stepIndex?: number };
    expect(opts.stepIndex).toBe(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("registers a beforeunload listener when dirty and removes it on unmount", async () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = render(<ListingWizardV2 userId="mgr-1" skuTier="starter" onClose={vi.fn()} />);
    // Make the editor dirty by changing a field.
    fireEvent.change(screen.getByPlaceholderText("Magnolia House"), {
      target: { value: "Dirty House" },
    });
    await waitFor(() => {
      expect(addEventListenerSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    });

    // Unmount the component and verify the listener was removed.
    unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });
});
