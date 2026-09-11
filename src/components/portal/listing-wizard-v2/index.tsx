"use client";

/**
 * The redesigned create-listing wizard.
 *
 * "Add property" opens the editor itself, at step 1. There used to be three
 * screens in front of it — address, confirm the address, how you rent it — and
 * every one of those questions is asked again on the Home step, so a manager
 * answered the same three things twice before reaching anything new.
 *
 * `AddPropertyFlow` and {@link submissionFromAddProperty} are kept for callers
 * that already collected those answers elsewhere; the wizard itself no longer
 * puts them in front of a manager, so only the result type is imported here.
 *
 * It reads and writes the SAME `ManagerListingSubmissionV1` the existing wizard
 * uses, so drafts, normalization, validation, publishing and every downstream
 * reader are unchanged. Nothing here is a second source of truth for a listing.
 */

import { useEffect, useRef, useState } from "react";
import type { AddPropertyResult } from "@/components/portal/listing-wizard-v2/add-property-flow";
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
  editListingId = null,
  editListingOwnerUserId = null,
  showToast,
  userId,
  skuTier,
  propertyCount = 0,
}: {
  onClose: () => void;
  /** Called once the draft is safely on the server. */
  onSaved?: (sub: ManagerListingSubmissionV1) => void;
  /**
   * Receives the PUBLISHED LISTING ID, not the submission.
   *
   * The caller navigates to the listing the manager just made; handing back the
   * submission instead left them on whichever stage they started from, which
   * after publishing a draft is the Drafts tab that no longer holds the row —
   * so finishing the wizard was rewarded with an empty list (PRP-429).
   */
  onPublished?: (listingId: string) => void;
  initialSubmission?: ManagerListingSubmissionV1 | null;
  initialDraftId?: string | null;
  /** Editing an existing live listing rather than creating one. */
  editListingId?: string | null;
  /** Its owner — a co-managed listing belongs to somebody else. */
  editListingOwnerUserId?: string | null;
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
    editListingId,
    editListingOwnerUserId,
  });
  // A new listing starts as an empty submission on step 1, not behind a
  // preamble. `createDefaultListingSubmission` already carries one room, so the
  // Rooms step has something to show the moment the manager reaches it.
  const [submission, setSubmission] = useState<ManagerListingSubmissionV1>(() =>
    normalizeManagerListingSubmissionV1(initialSubmission ?? createDefaultListingSubmission()),
  );

  const label = submission.buildingName.trim() || submission.address.trim() || "New listing";
  const editing = Boolean(editListingId?.trim());

  /*
   * Whether the manager's work is on the server, stated in the header.
   *
   * This wizard does NOT autosave — `useListingPersistence` writes on Save and
   * on Publish, and nowhere else — so the header must never say "Saved" merely
   * because time has passed. It reports what actually happened: unsaved from the
   * first edit until a save comes back ok, and saved again only then.
   */
  const [dirty, setDirty] = useState(false);
  /*
   * The submission as it last stood on the server. Compared by reference, not by
   * a "have I rendered before" flag — an effect that fires twice in development
   * would report unsaved work the instant the editor opened.
   */
  const savedRef = useRef(submission);
  useEffect(() => {
    setDirty(submission !== savedRef.current);
  }, [submission]);
  const markSaved = () => {
    savedRef.current = submission;
    setDirty(false);
  };
  const saveState = busy ? "Saving…" : dirty ? "Unsaved changes" : editing ? "Saved" : "Not saved yet";

  return (
    <ListingEditorV2
      title={label}
      submission={submission}
      onChange={setSubmission}
      onClose={onClose}
      busy={busy}
      isEdit={editing}
      saveState={saveState}
      onSaveExit={async (stepIndex) => {
        if (editListingId?.trim()) {
          // There is no draft behind an edit — "save and exit" writes the
          // listing itself, which is the same write Publish makes.
          const result = await publish(submission);
          if (!result.ok) {
            showToast?.(result.message);
            return;
          }
          markSaved();
          onSaved?.(submission);
          showToast?.("Changes saved.");
          onClose();
          return;
        }
        const result = await saveDraft(submission, stepIndex);
        if (!result.ok) {
          // The manager's work stays on screen; a failed save must never look
          // like a successful one.
          showToast?.(result.message);
          return;
        }
        markSaved();
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
        onPublished?.(result.id);
      }}
    />
  );
}
