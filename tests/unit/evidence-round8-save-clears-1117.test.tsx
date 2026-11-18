// @vitest-environment jsdom
/**
 * Evidence harness (round 8, 2026-11-17): a successful save clears the
 * "Unsaved changes" chip even when the save normalizes the submission on its
 * way to the server, and an edit-mode finish asks "Save anyway?" (not
 * "Publish anyway?") when the listing still has a gap.
 *
 * Screenshot-ready HTML is written only when EVIDENCE_DIR is set.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeEvidencePage } from "../helpers/evidence-page";
import { renderedBodyHtml } from "../helpers/evidence-dom";

const saveDraft = vi.hoisted(() => vi.fn(async () => "mgr-draft-1"));
vi.mock("@/lib/demo-admin-property-inventory", () => ({ publishManagerPropertyDraftToServer: vi.fn(), saveManagerPropertyDraftToServer: saveDraft }));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn(), updateExtraListingFromSubmissionOnServer: vi.fn(async () => true) }));
vi.mock("@/lib/native/app-review", () => ({ recordDelightMoment: vi.fn() }));
vi.mock("@/lib/manager-subscription-client", () => ({ loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false) }));
// The save normalizes on the way out, so the prepared submission is a different object than the typed one.
vi.mock("@/lib/prepare-listing-submission-for-persist", () => ({
  prepareListingSubmissionForPersist: vi.fn(async (sub: { buildingName: string }) => ({
    submission: { ...sub, buildingName: sub.buildingName.trim(), description: "normalized" },
    droppedMediaCount: 0,
  })),
  listingSaveFailureMessage: (reason: string) => reason || "Could not save.",
}));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: vi.fn(() => false) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/portal/properties" }));

import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

function page(name: string, title: string) {
  writeEvidencePage(name, renderedBodyHtml(), { title, width: 1180 });
}

afterEach(() => {
  cleanup();
  saveDraft.mockClear();
});

describe("Save clears Unsaved changes — round 8 evidence", () => {
  it("shows Unsaved changes after typing and clears it once the normalizing save lands", async () => {
    const flushRef = { current: null as null | (() => Promise<boolean>) };
    render(<ListingWizardV2 onClose={vi.fn()} userId="mgr-1" skuTier="starter" initialDraftId="mgr-draft-1" flushRef={flushRef} />);
    fireEvent.change(screen.getByPlaceholderText("Magnolia House"), { target: { value: "Maple House" } });
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    page("save-01-unsaved", 'After typing a name — the header reads "Unsaved changes"');

    await flushRef.current!();
    await waitFor(() => expect(saveDraft).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(screen.getByText("Saved")).toBeTruthy();
    page("save-02-saved", 'After the save lands — the chip reads "Saved", with nothing left unsaved');
  });

  it('an edit-mode finish asks "Save anyway?", naming the button the manager pressed', async () => {
    const base = createDefaultListingSubmission();
    const initial = {
      ...base,
      address: "142 Ash St",
      city: "Brooklyn",
      state: "NY",
      zip: "11201",
      listingPlaceCategoryId: "entire_home",
      allowedLeaseTerms: [LONG_TERM_LEASE_TERM],
      entireHomeMonthlyRent: 3200,
      housePhotoDataUrls: [],
    } as ManagerListingSubmissionV1;
    const onPublish = vi.fn(async () => true);
    function Harness() {
      const [sub, setSub] = useState(initial);
      return (
        <AppUiProvider>
          <ListingEditorV2 title="142 Ash St" isEdit submission={sub} onChange={setSub} onClose={() => {}} onPublish={onPublish} />
        </AppUiProvider>
      );
    }
    render(<Harness />);
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-review"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Save anyway?")).toBeTruthy());
    expect(screen.getByText("No photos yet.")).toBeTruthy();
    page("save-03-edit-save-anyway", 'Editing a listed home · Save with no photo asks "Save anyway?" — the ask names the button that was pressed');
    expect(onPublish).not.toHaveBeenCalled();
  });
});
