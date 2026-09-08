"use client";

/**
 * The redesigned create-listing wizard, end to end.
 *
 * Phase 1 ({@link AddPropertyFlow}) turns three short screens into a real
 * listing. Phase 2 ({@link ListingEditorV2}) completes it across six named steps
 * that can be left and resumed at any point.
 *
 * It reads and writes the SAME `ManagerListingSubmissionV1` the existing wizard
 * uses, so drafts, normalization, validation, publishing and every downstream
 * reader are unchanged. Nothing here is a second source of truth for a listing.
 */

import { useCallback, useState } from "react";
import { AddPropertyFlow, type AddPropertyResult } from "@/components/portal/listing-wizard-v2/add-property-flow";
import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { useListingPersistence } from "@/components/portal/listing-wizard-v2/use-listing-persistence";
import {
  applyListingBedroomSlots,
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

export { listingReadiness } from "@/components/portal/listing-wizard-v2/listing-editor";

/** Build the starting submission from the three answers phase 1 collects. */
export function submissionFromAddProperty(result: AddPropertyResult): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const seeded: ManagerListingSubmissionV1 = {
    ...base,
    address: result.address,
    city: result.city,
    state: result.state,
    zip: result.zip,
    neighborhood: result.neighborhood || base.neighborhood,
    // The submission has no unit field of its own — a unit is part of how the
    // listing is named, which is what the address line and listing name carry.
    buildingName: base.buildingName || [result.address, result.unitLabel && `Unit ${result.unitLabel}`]
      .filter(Boolean)
      .join(" · "),
    listingPropertyTypeId: result.propertyTypeId,
    // "By the room" versus "the whole place" is the one phase-1 answer that
    // changes every screen after it, so it is stamped on the submission rather
    // than inferred later.
    listingPlaceCategoryId: result.rentByRoom ? "shared_home" : "entire_home",
    rentalModelStamp: result.rentByRoom ? "shared_home" : "entire_home",
    listingBedroomSlots: result.bedrooms,
  };
  const withRooms = applyListingBedroomSlots(seeded, result.bedrooms);
  return normalizeManagerListingSubmissionV1(withRooms.ok ? withRooms.sub : seeded);
}

export function ListingWizardV2({
  onClose,
  onSaved,
  onPublished,
  initialSubmission = null,
  initialDraftId = null,
  showToast,
  userId,
  skuTier,
  propertyCount = 0,
}: {
  onClose: () => void;
  /** Called once the draft is safely on the server. */
  onSaved?: (sub: ManagerListingSubmissionV1) => void;
  onPublished?: (sub: ManagerListingSubmissionV1) => void;
  initialSubmission?: ManagerListingSubmissionV1 | null;
  initialDraftId?: string | null;
  showToast?: (message: string) => void;
  userId: string | null;
  skuTier: string | null | undefined;
  /** The manager's current property count, for the plan pre-check. */
  propertyCount?: number;
}) {
  const { saveDraft, publish, busy } = useListingPersistence({
    userId,
    skuTier,
    propertyCount,
    initialDraftId,
  });
  const [submission, setSubmission] = useState<ManagerListingSubmissionV1 | null>(
    initialSubmission ? normalizeManagerListingSubmissionV1(initialSubmission) : null,
  );

  const create = useCallback((result: AddPropertyResult) => {
    setSubmission(submissionFromAddProperty(result));
  }, []);

  if (!submission) {
    return <AddPropertyFlow onCancel={onClose} onCreate={create} creating={busy} />;
  }

  const label = submission.buildingName.trim() || submission.address.trim() || "New listing";

  return (
    <ListingEditorV2
      title={label}
      submission={submission}
      onChange={setSubmission}
      onClose={onClose}
      busy={busy}
      onSaveExit={async (stepIndex) => {
        const result = await saveDraft(submission, stepIndex);
        if (!result.ok) {
          // The manager's work stays on screen; a failed save must never look
          // like a successful one.
          showToast?.(result.message);
          return;
        }
        onSaved?.(submission);
        showToast?.("Saved to Drafts.");
        onClose();
      }}
      onPublish={async () => {
        const result = await publish(submission);
        if (!result.ok) {
          showToast?.(result.message);
          return;
        }
        onPublished?.(submission);
        showToast?.("Listing published.");
        onClose();
      }}
    />
  );
}
