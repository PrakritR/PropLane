// @vitest-environment jsdom
//
// "Edits must save": a question edited in the listing editor's Application step is held as a DRAFT until the
// inline publisher runs (1.2 s after the last keystroke, when the card closes, when the step leaves). Pressing
// the editor's X inside that window must still store, and publish, the edit: applicants read the PUBLISHED
// config, so a draft-only save looks saved in the editor and changes nothing for them.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const updateListing = vi.hoisted(() => vi.fn());
const saveDraft = vi.hoisted(() => vi.fn());

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  saveManagerPropertyDraftToServer: (...args: unknown[]) => saveDraft(...args),
  publishManagerPropertyDraftToServer: vi.fn(),
  readAdminPropertyRows: vi.fn(() => []),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  submitManagerPendingPropertyToServer: vi.fn(),
  updateExtraListingFromSubmissionOnServer: (...args: unknown[]) => updateListing(...args),
}));
vi.mock("@/lib/manager-subscription-client", () => ({ loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false) }));
vi.mock("@/lib/native/app-review", () => ({ recordDelightMoment: vi.fn() }));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: () => false }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/prepare-listing-submission-for-persist", () => ({
  prepareListingSubmissionForPersist: vi.fn(async (sub: unknown) => ({ submission: sub, droppedMediaCount: 0 })),
  listingSaveFailureMessage: (reason: string) => reason || "Could not save.",
}));

import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import {
  applicationTemplateQuestionConfigFromSlice,
  publishApplicationTemplateQuestionDraft,
  readPropertyApplicationTemplates,
} from "@/lib/property-application-templates";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const iso = "2026-10-01T00:00:00Z";

function publishedForm(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const draft = applicationTemplateQuestionConfigFromSlice({
    applicationConfigMode: "custom",
    disabledStandardApplicationKeys: [],
    customApplicationFields: [{ id: "c-pet", key: "pet-name", label: "Pet name", type: "text", required: false, options: [], section: "additional" }],
  } as never);
  const form = publishApplicationTemplateQuestionDraft({
    id: "a-long",
    kind: "long-term",
    formVariant: "standard",
    label: "Long-term application",
    draftQuestionConfig: draft,
    createdAt: iso,
    updatedAt: iso,
  } as never);
  return {
    ...base,
    address: "400 Pike Street",
    city: "Seattle",
    state: "WA",
    zip: "98101",
    rooms: [{ ...base.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 1100 }],
    propertyApplicationTemplates: [form],
    propertyApplicationTemplatesExplicit: true,
  } as unknown as ManagerListingSubmissionV1;
}

const fetchMock = vi.fn();
const patchCalls = () =>
  (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).filter(([url, init]) => url === "/api/portal/application-template-import" && init?.method === "PATCH");

beforeEach(() => {
  updateListing.mockReset().mockResolvedValue(true);
  saveDraft.mockReset().mockResolvedValue("draft-1");
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) =>
    url === "/api/portal/application-template-import" && init?.method === "PATCH"
      ? { ok: true, json: async () => ({ version: 2 }) }
      : { ok: true, json: async () => ({}) },
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("closing the editor right after a question edit", () => {
  it("stores the edit and publishes the saved draft, so applicants see it", async () => {
    const onClose = vi.fn();
    render(<ListingWizardV2 onClose={onClose} userId="mgr-1" skuTier="starter" editListingId="listing-1" initialSubmission={publishedForm()} initialStep="application" showToast={() => {}} />);
    const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;

    fireEvent.click(q("[data-attr='listing-v2-application-card'] [data-attr='listing-v2-card-open']")!);
    const prefix = "listing-v2-application-editor";
    const section = q(`[data-attr="${prefix}-section-toggle-additional"]`)!;
    if (section.getAttribute("aria-expanded") !== "true") fireEvent.click(section);
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-question-id]")).find((el) => el.textContent?.includes("Pet name"))!;
    fireEvent.click(row.querySelector(`[data-attr="${prefix}-question-open"]`)!);
    fireEvent.click(q(`[data-attr="${prefix}-question-required"]`)!);

    // X straight away: well inside the publisher's pause.
    fireEvent.click(screen.getAllByRole("button", { name: /Close/i })[0]!);
    await waitFor(() => expect(updateListing).toHaveBeenCalled());
    const saved = updateListing.mock.calls.at(-1)![2] as ManagerListingSubmissionV1;
    const form = readPropertyApplicationTemplates(saved).find((row) => row.id === "a-long")!;
    const draftPet = form.draftQuestionConfig?.customApplicationFields.find((field) => field.id === "c-pet");
    expect(draftPet?.required, "the saved draft holds the edit").toBe(true);
    // A generic save never publishes (the server keeps the stored published form), so the editor publishes the
    // saved draft itself, against the version the server last published.
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(JSON.parse(patchCalls()[0]![1].body as string)).toEqual({ propertyId: "listing-1", templateId: "a-long", expectedPublishedVersion: 1 });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
