// @vitest-environment jsdom
//
// Manager "View application" embeds the wizard with templatePreview — it must
// never rewrite the URL to /resident/applications/apply (that route rejects
// managers and bounces them to sign-in).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import { STANDARD_APPLICATION_FIELD_CATALOG } from "@/lib/rental-application/application-field-catalog";

const routerReplace = vi.fn();
const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: routerPush, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const LISTING_ID = "mgr-preview-listing";

function seedListingWithSubmission(input: ReturnType<typeof createDefaultListingSubmission>): void {
  const sub = input;
  const property: MockProperty = {
    id: LISTING_ID,
    title: "Preview Flat",
    tagline: "Test",
    address: "1 Test St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Preview Flat",
    unitLabel: "Unit 1",
    adminPublishLive: true,
    managerUserId: "mgr-preview",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

function seedListing(): void {
  seedListingWithSubmission(createDefaultListingSubmission());
}

beforeEach(() => {
  routerReplace.mockClear();
  routerPush.mockClear();
  seedListing();
});

afterEach(() => {
  cleanup();
});

describe("RentalApplicationWizard templatePreview", () => {
  it("does not navigate to the resident apply route while previewing", async () => {
    render(
      <RentalApplicationWizard
        showToast={() => {}}
        mode="manager"
        layout="embedded"
        linkedPropertyId={LISTING_ID}
        templatePreview
        onManagerCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(routerReplace).not.toHaveBeenCalled();
      expect(routerPush).not.toHaveBeenCalled();
    });
  });

  it("renders configured built-in identity labels in the applicant preview", async () => {
    const sub = createDefaultListingSubmission();
    const name = STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.label === "Full legal name")!;
    sub.customApplicationFields = [{
      id: "applicant-name-override",
      key: "full_legal_name",
      label: "Applicant full name",
      type: "text",
      required: true,
      options: [],
      section: "personal",
      standardKey: name.standardKey,
    }];
    seedListingWithSubmission(sub);
    render(
      <RentalApplicationWizard
        showToast={() => {}}
        mode="manager"
        layout="embedded"
        linkedPropertyId={LISTING_ID}
        templatePreview
        templatePreviewSubmission={sub}
      />,
    );
    fireEvent.click(screen.getByRole("group", { name: "Group application" }).querySelectorAll("button")[1]);
    fireEvent.click(screen.getByRole("group", { name: "Co-signer" }).querySelectorAll("button")[1]);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Applicant full name")).toBeTruthy();
  });

  it("uses co-signer questions for a co-signer full preview", async () => {
    const sub = createDefaultListingSubmission();
    sub.cosignerApplicationConfigMode = "custom";
    sub.cosignerCustomApplicationFields = [{
      id: "cosigner-review-question",
      key: "cosigner_review_question",
      label: "Co-signer-only prompt",
      type: "text",
      required: true,
      options: [],
      section: "household",
    }];
    seedListingWithSubmission(sub);
    render(
      <RentalApplicationWizard
        showToast={() => {}}
        mode="manager"
        layout="embedded"
        linkedPropertyId={LISTING_ID}
        templatePreview
        templatePreviewVariant="cosigner"
        templatePreviewSubmission={sub}
      />,
    );
    expect(await screen.findByText("Co-signer-only prompt")).toBeTruthy();
  });
});
