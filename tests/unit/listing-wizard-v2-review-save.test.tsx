// @vitest-environment jsdom
//
// The footer is Back + Continue on every step except Review, where it is
// Back + Publish. Closing the editor still writes the draft.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";

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

  it("Review is Back + Publish only", () => {
    mount(false);
    goToReview();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Continue to/ })).toBeNull();
  });

  it("a live listing Review is still Publish, never Save", () => {
    mount(true);
    goToReview();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("earlier steps carry Continue and not Save or Publish", () => {
    mount(true);
    expect(screen.getByRole("button", { name: /^Continue to/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });

  it("while a write is in flight Publish is disabled", () => {
    mount(true, true);
    goToReview();
    const publish = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
  });
});

