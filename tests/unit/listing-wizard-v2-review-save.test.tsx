// @vitest-environment jsdom
//
// Save and Publish remain available throughout the wizard. Save preserves the
// current work without closing the editor; a failure keeps the work available
// for another attempt.
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
    const onSave = vi.fn(async () => true);
    const onPublish = vi.fn();
    render(
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
        <ListingEditorV2
          title="Ash Flats"
          submission={createDefaultListingSubmission()}
          onChange={() => {}}
          onClose={() => {}}
          onSave={onSave}
          onPublish={onPublish}
          isEdit={isEdit}
          busy={busy}
        />
      </PortalAssistantConfigProvider>,
    );
    return { onSave, onPublish };
  }

  it("a draft has Save beside Publish; Save saves, it does not publish", () => {
    const { onSave, onPublish } = mount(false);
    goToReview();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.getAttribute("data-attr")).toBe("listing-v2-save-draft");
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(REVIEW);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("a live listing has Save beside Publish, labelled Save", () => {
    const { onSave, onPublish } = mount(true);
    goToReview();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.getAttribute("data-attr")).toBe("listing-v2-save");
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(REVIEW);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("earlier steps carry Continue, Save, and Publish", () => {
    mount(true);
    expect(screen.getByRole("button", { name: /^Continue to/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
  });

  it("while a write is in flight Save and Publish are disabled", () => {
    mount(true, true);
    goToReview();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    const publish = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(publish.disabled).toBe(true);
    expect(save.getAttribute("data-attr")).toBe("listing-v2-save");
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

  it("writes the unsaved change in place and keeps the editor open", async () => {
    const onClose = mountEdit();
    fireEvent.change(screen.getByDisplayValue("Ash Flats"), { target: { value: "Ash Flats 6" } });
    goToReview();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateExtraListingFromSubmissionOnServer).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
  });

  it("with nothing unsaved it stays open and writes nothing", async () => {
    const onClose = mountEdit();
    goToReview();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    expect(onClose).not.toHaveBeenCalled();
    expect(updateExtraListingFromSubmissionOnServer).not.toHaveBeenCalled();
  });

  it("a failed write keeps the editor open with the change still in it", async () => {
    updateExtraListingFromSubmissionOnServer.mockResolvedValue(false);
    const onClose = mountEdit();
    fireEvent.change(screen.getByDisplayValue("Ash Flats"), { target: { value: "Ash Flats 6" } });
    goToReview();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    // X gives up and closes on the SECOND failure; Save must not.
    await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(2));
    expect(updateExtraListingFromSubmissionOnServer).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /attention|Ready to publish/ })).toBeTruthy();
  });
});
