// @vitest-environment jsdom
//
// The v2 editor saves ONCE, when the manager presses ✕. There is no typing
// timer: type all you like and nothing is sent until you close. An untouched
// new listing writes nothing. A refused close-save shows ONE dialog — Keep
// editing / Try again / Leave without saving — never a toast that returns on
// the next keystroke.
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

import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";

afterEach(() => {
  cleanup();
  saveManagerPropertyDraftToServer.mockReset();
  saveManagerPropertyDraftToServer.mockResolvedValue("mgr-draft-1");
  updateExtraListingFromSubmissionOnServer.mockReset();
  updateExtraListingFromSubmissionOnServer.mockResolvedValue(true as never);
});

/** The property-name field the mocks and the mock plan both type into. */
function propertyNameField() {
  return screen.getByPlaceholderText("Magnolia House");
}

/** The save-failed dialog, present only after a refused close-save. */
function saveFailedDialog() {
  return document.querySelector('[data-attr="listing-save-failed-dialog"]');
}

describe("listing wizard v2 — save on close, no typing timer", () => {
  it("does not write an untouched new listing on close", async () => {
    const onClose = vi.fn();
    render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" />);
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
  });

  it("sends nothing while the manager types — even after well over two seconds", async () => {
    render(<ListingWizardV2 onClose={vi.fn()} userId="mgr-1" skuTier="starter" />);
    fireEvent.change(propertyNameField(), { target: { value: "Cards QA house" } });
    // There is no debounce to fire; wait past the old 2s window to prove it.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
  });

  it("writes exactly one draft on ✕", async () => {
    const onClose = vi.fn();
    render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" />);
    fireEvent.change(propertyNameField(), { target: { value: "Cards QA house" } });
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(saveManagerPropertyDraftToServer).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
  });

  it("flushes a dirty live edit on ✕ without forking a draft", async () => {
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

  describe("when the close-save is refused", () => {
    function stubRefusal(message = "Select an owned workspace before adding a property.") {
      saveManagerPropertyDraftToServer.mockImplementation(
        async (_sub: unknown, _uid: unknown, opts?: { onError?: (m: string) => void }) => {
          opts?.onError?.(message);
          return null as unknown as string;
        },
      );
    }

    it("shows one dialog with the server reason and no toast", async () => {
      const onClose = vi.fn();
      const showToast = vi.fn();
      render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" showToast={showToast} />);
      fireEvent.change(propertyNameField(), { target: { value: "Cards QA house" } });
      stubRefusal();
      fireEvent.click(screen.getByRole("button", { name: /Close/i }));

      await waitFor(() => expect(saveFailedDialog()).not.toBeNull());
      expect(
        document.querySelector('[data-attr="listing-save-failed-reason"]')?.textContent,
      ).toMatch(/select an owned workspace/i);
      expect(onClose).not.toHaveBeenCalled();
      // The whole point of the change: no toast, on the first refusal or any after.
      expect(showToast).not.toHaveBeenCalledWith(expect.stringMatching(/owned workspace|could not save/i));
      // Exactly one write was attempted.
      expect(saveManagerPropertyDraftToServer).toHaveBeenCalledTimes(1);
    });

    it("Keep editing dismisses the dialog and keeps the form", async () => {
      const onClose = vi.fn();
      render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" />);
      fireEvent.change(propertyNameField(), { target: { value: "Cards QA house" } });
      stubRefusal();
      fireEvent.click(screen.getByRole("button", { name: /Close/i }));
      await waitFor(() => expect(saveFailedDialog()).not.toBeNull());

      fireEvent.click(document.querySelector('[data-attr="listing-save-failed-keep"]')!);

      await waitFor(() => expect(saveFailedDialog()).toBeNull());
      expect(onClose).not.toHaveBeenCalled();
      expect((propertyNameField() as HTMLInputElement).value).toBe("Cards QA house");
    });

    it("Try again sends exactly one more save and closes when it lands", async () => {
      const onClose = vi.fn();
      render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" />);
      fireEvent.change(propertyNameField(), { target: { value: "Cards QA house" } });
      stubRefusal();
      fireEvent.click(screen.getByRole("button", { name: /Close/i }));
      await waitFor(() => expect(saveFailedDialog()).not.toBeNull());
      expect(saveManagerPropertyDraftToServer).toHaveBeenCalledTimes(1);

      // The retry succeeds.
      saveManagerPropertyDraftToServer.mockResolvedValue("mgr-draft-1");
      fireEvent.click(document.querySelector('[data-attr="listing-save-failed-retry"]')!);

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(saveManagerPropertyDraftToServer).toHaveBeenCalledTimes(2);
      expect(saveFailedDialog()).toBeNull();
    });

    it("Leave without saving closes with no further write", async () => {
      const onClose = vi.fn();
      render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" />);
      fireEvent.change(propertyNameField(), { target: { value: "Cards QA house" } });
      stubRefusal();
      fireEvent.click(screen.getByRole("button", { name: /Close/i }));
      await waitFor(() => expect(saveFailedDialog()).not.toBeNull());
      expect(saveManagerPropertyDraftToServer).toHaveBeenCalledTimes(1);

      fireEvent.click(document.querySelector('[data-attr="listing-save-failed-leave"]')!);

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      // No retry write happened — Leave discards.
      expect(saveManagerPropertyDraftToServer).toHaveBeenCalledTimes(1);
    });
  });
});
