// @vitest-environment jsdom
//
// The Review step's physical Save. Autosave and X already write on their own;
// this is the visible commit a manager reaches for on the last step. On a live
// listing it is "Save changes"; on a draft it is "Save draft" beside Publish.
// A save that lands closes the editor. A save that fails keeps the editor open
// with the work still in it — the button exists to keep work, so unlike X it
// never gives up and leaves.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const saveManagerPropertyDraftToServer = vi.hoisted(() => vi.fn(async () => "mgr-draft-1"));
const updateExtraListingFromSubmissionOnServer = vi.hoisted(() => vi.fn(async () => true));
const showToast = vi.hoisted(() => vi.fn());

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer,
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  submitManagerPendingPropertyToServer: vi.fn(),
  updateExtraListingFromSubmissionOnServer,
}));
vi.mock("@/lib/native/app-review", () => ({ recordDelightMoment: vi.fn() }));
vi.mock("@/lib/manager-subscription-client", () => ({
  loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false),
}));
vi.mock("@/lib/prepare-listing-submission-for-persist", () => ({
  prepareListingSubmissionForPersist: vi.fn(async (sub: unknown) => ({ submission: sub, droppedMediaCount: 0 })),
  listingSaveFailureMessage: (reason: string) => reason || "Could not save.",
}));

import { LISTING_V2_STEPS, ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";

const REVIEW = LISTING_V2_STEPS.length - 1;

function goToReview() {
  fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-review"]')!);
}

afterEach(() => {
  cleanup();
  saveManagerPropertyDraftToServer.mockReset().mockResolvedValue("mgr-draft-1");
  updateExtraListingFromSubmissionOnServer.mockReset().mockResolvedValue(true);
  showToast.mockReset();
});

describe("the Review step footer (editor shell)", () => {
  function mount(isEdit: boolean, busy = false) {
    const onSaveExit = vi.fn();
    const onPublish = vi.fn();
    render(
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
        <ListingEditorV2
          title="Ash Flats"
          submission={createDefaultListingSubmission()}
          onChange={() => {}}
          onClose={() => {}}
          onSaveExit={onSaveExit}
          onPublish={onPublish}
          isEdit={isEdit}
          busy={busy}
        />
      </PortalAssistantConfigProvider>,
    );
    return { onSaveExit, onPublish };
  }

  it("a draft has Save draft beside Publish; Save draft saves, it does not publish", () => {
    const { onSaveExit, onPublish } = mount(false);
    goToReview();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(onSaveExit).toHaveBeenCalledWith(REVIEW);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("a live listing has Save changes and no Save draft", () => {
    const { onSaveExit } = mount(true);
    goToReview();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveExit).toHaveBeenCalledWith(REVIEW);
  });

  it("earlier steps still carry Continue, never a Save", () => {
    mount(true);
    expect(screen.getByRole("button", { name: /^Continue to/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("while a write is in flight the Save is disabled and says so", () => {
    mount(true, true);
    goToReview();
    const btn = screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("data-attr")).toBe("listing-v2-save");
  });
});

describe("the Review step Save (whole wizard)", () => {
  function mountEdit(onClose = vi.fn()) {
    const initial = { ...createDefaultListingSubmission(), buildingName: "Ash Flats" };
    render(
      <ListingWizardV2
        onClose={onClose}
        showToast={showToast}
        userId="mgr-1"
        skuTier="starter"
        editListingId="mgr-ash"
        editListingOwnerUserId="mgr-1"
        initialSubmission={initial}
      />,
    );
    return onClose;
  }

  it("writes the unsaved change in place and closes the editor", async () => {
    const onClose = mountEdit();
    fireEvent.change(screen.getByDisplayValue("Ash Flats"), { target: { value: "Ash Flats 6" } });
    goToReview();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateExtraListingFromSubmissionOnServer).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
  });

  it("with nothing unsaved it simply closes, writing nothing", async () => {
    const onClose = mountEdit();
    goToReview();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateExtraListingFromSubmissionOnServer).not.toHaveBeenCalled();
  });

  it("a failed write keeps the editor open with the change still in it", async () => {
    updateExtraListingFromSubmissionOnServer.mockResolvedValue(false);
    const onClose = mountEdit();
    fireEvent.change(screen.getByDisplayValue("Ash Flats"), { target: { value: "Ash Flats 6" } });
    goToReview();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    // X gives up and closes on the SECOND failure; Save must not.
    await waitFor(() => expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(2));
    expect(updateExtraListingFromSubmissionOnServer).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /attention|Ready to publish/ })).toBeTruthy();
  });
});
