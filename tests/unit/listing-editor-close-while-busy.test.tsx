// @vitest-environment jsdom
//
// PRP-486: `handleClose` used to return in total silence when a close was
// reached while a save/publish was already in flight (`lifecycleRef.current`)
// — no toast, no closed editor, nothing to tell the manager their click did
// not register. It now shows the same "Saving…" copy the header's own
// autosave status already shows while busy, and still closes exactly once,
// after the in-flight save finishes.
//
// The close paths are the editor's own: the ✕ (disabled while busy) and the
// footer. There is deliberately no keyboard close — the workspace is a plain
// full-screen overlay, not a dialog host, and a document-level Escape listener
// closed the editor (re-running its save) every time a manager dismissed a
// Floor menu, because the field dropdowns own Escape and do not stop it
// propagating.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
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

type Flush = MutableRefObject<(() => Promise<boolean>) | null>;

/**
 * The wizard as the properties panel mounts it, including the host's flush
 * handle. A flush the HOST starts (its own "leaving this screen" save) runs
 * outside any React event, which is the real window in which a ✕ click can
 * still land before the button has re-rendered as disabled.
 */
function renderWizard(onClose: () => void, showToast: (message: string) => void): Flush {
  const flushRef: Flush = { current: null };
  render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" showToast={showToast} flushRef={flushRef} />);
  return flushRef;
}

describe("listing editor close while busy (PRP-486)", () => {
  it("disables the ✕ while the save it started is in flight, then closes exactly once", async () => {
    const onClose = vi.fn();
    const showToast = vi.fn();
    renderWizard(onClose, showToast);

    // Make the draft dirty so a save actually runs.
    fireEvent.change(screen.getByPlaceholderText("Magnolia House"), {
      target: { value: "Cards QA house" },
    });

    const closeButton = screen.getByRole("button", { name: /Close/i });
    fireEvent.click(closeButton); // starts the save; lifecycleRef is now busy
    await waitFor(() => expect(draftSave.fn).toHaveBeenCalledTimes(1));

    expect(closeButton).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    // Resolve the in-flight save: the editor closes exactly once.
    draftSave.resolvers.shift()!("mgr-draft-1");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(draftSave.fn).toHaveBeenCalledTimes(1);
  });

  it("says Saving… when a close reaches the handler while a lifecycle op is in flight", async () => {
    const onClose = vi.fn();
    const showToast = vi.fn();
    const flushRef = renderWizard(onClose, showToast);

    fireEvent.change(screen.getByPlaceholderText("Magnolia House"), {
      target: { value: "Cards QA house" },
    });

    // The host starts its flush and the manager presses ✕ in the same tick,
    // before the button has re-rendered as disabled — the exact close PRP-486's
    // guard has to answer out loud rather than drop.
    void flushRef.current!();
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));

    expect(showToast).toHaveBeenCalledWith("Saving…");
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(draftSave.fn).toHaveBeenCalledTimes(1));
    expect(draftSave.fn).toHaveBeenCalledTimes(1);

    draftSave.resolvers.shift()!("mgr-draft-1");
    await waitFor(() => expect(draftSave.fn).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes normally on a single close with nothing in flight", async () => {
    const onClose = vi.fn();
    const showToast = vi.fn();
    renderWizard(onClose, showToast);
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showToast).not.toHaveBeenCalledWith("Saving…");
  });
});
