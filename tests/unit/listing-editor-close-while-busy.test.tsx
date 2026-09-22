// @vitest-environment jsdom
//
// PRP-486: `handleClose` used to return in total silence when a close was
// reached while a save/publish was already in flight (`lifecycleRef.current`)
// — no toast, no closed editor, nothing to tell the manager their click did
// not register. It now shows the same "Saving…" copy the header's own
// autosave status already shows while busy, and still closes exactly once,
// after the in-flight save finishes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const draftSave = vi.hoisted(() => {
  const resolvers: Array<(id: string) => void> = [];
  const fn = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return { fn, resolvers };
});

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: draftSave.fn,
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  submitManagerPendingPropertyToServer: vi.fn(),
  updateExtraListingFromSubmissionOnServer: vi.fn(async () => true),
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
  draftSave.fn.mockClear();
  draftSave.resolvers.length = 0;
});

describe("listing editor close while busy (PRP-486)", () => {
  it("toasts instead of silently dropping a second close reached while the first is still saving", async () => {
    const onClose = vi.fn();
    const showToast = vi.fn();
    render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" showToast={showToast} />);

    // Make the draft dirty so X actually starts a save.
    fireEvent.change(screen.getByPlaceholderText("Magnolia House"), {
      target: { value: "Cards QA house" },
    });

    const closeButton = screen.getByRole("button", { name: /Close/i });
    fireEvent.click(closeButton); // starts the save; lifecycleRef is now busy
    await waitFor(() => expect(draftSave.fn).toHaveBeenCalledTimes(1));

    // A second close reaches handleClose while the first save is still in flight.
    fireEvent.click(closeButton);

    expect(showToast).toHaveBeenCalledWith("Saving…");
    // Nothing closed and no second save was started for the redundant click.
    expect(onClose).not.toHaveBeenCalled();
    expect(draftSave.fn).toHaveBeenCalledTimes(1);

    // Resolve the in-flight save: the editor closes exactly once.
    draftSave.resolvers.shift()!("mgr-draft-1");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes normally on a single close with nothing in flight", async () => {
    const onClose = vi.fn();
    const showToast = vi.fn();
    render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" showToast={showToast} />);
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showToast).not.toHaveBeenCalledWith("Saving…");
  });
});
