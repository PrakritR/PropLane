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
  showToast,
}: {
  onClose: () => void;
  /** Called with the current submission whenever the manager saves and exits. */
  onSaved?: (sub: ManagerListingSubmissionV1) => void;
  onPublished?: (sub: ManagerListingSubmissionV1) => void;
  initialSubmission?: ManagerListingSubmissionV1 | null;
  showToast?: (message: string) => void;
}) {
  const [submission, setSubmission] = useState<ManagerListingSubmissionV1 | null>(
    initialSubmission ? normalizeManagerListingSubmissionV1(initialSubmission) : null,
  );

  const create = useCallback((result: AddPropertyResult) => {
    setSubmission(submissionFromAddProperty(result));
  }, []);

  if (!submission) {
    return <AddPropertyFlow onCancel={onClose} onCreate={create} />;
  }

  const label = submission.buildingName.trim() || submission.address.trim() || "New listing";

  return (
    <ListingEditorV2
      title={label}
      submission={submission}
      onChange={setSubmission}
      onClose={onClose}
      onSaveExit={() => {
        onSaved?.(submission);
        showToast?.("Saved to Drafts.");
        onClose();
      }}
      onPublish={() => {
        onPublished?.(submission);
        showToast?.("Listing published.");
        onClose();
      }}
    />
  );
}
