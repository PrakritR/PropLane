"use client";

/**
 * The listing editor — one surface for adding a property and for editing it.
 *
 * There used to be two: a four-screen "Quick Add" that asked what, where, how
 * and how much before the property existed, and the editor a manager landed in
 * afterwards. Both asked the same first questions, and both were disliked for
 * different reasons — the modal for making a manager click through four cards
 * to reach a form, the editor for opening as a wall of selects. So the two are
 * ONE editor now: a brand-new property opens straight in it at Basics, where
 * the property type is a row of tiles, how-you-rent-it is two cards, and the
 * address and bedroom count sit right under them. Typing and X save the
 * draft (or the live listing, when editing). Publish is the last section.
 *
 * `AddPropertyFlow` and {@link submissionFromAddProperty} are kept for callers
 * that already collected those answers elsewhere.
 *
 * It reads and writes the SAME `ManagerListingSubmissionV1` the existing wizard
 * uses, so drafts, normalization, validation, publishing and every downstream
 * reader are unchanged. Nothing here is a second source of truth for a listing.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import type { AddPropertyResult } from "@/components/portal/listing-wizard-v2/add-property-flow";
import { ListingEditorV2, type ListingEditorLeadingStep } from "@/components/portal/listing-wizard-v2/listing-editor";
import { useListingPersistence } from "@/components/portal/listing-wizard-v2/use-listing-persistence";
import {
  applyListingBathroomSlots,
  applyListingBedroomSlots,
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { loadManagerPaymentWaiverGrantedClient } from "@/lib/manager-subscription-client";
import { prepareListingSubmissionForPersist } from "@/lib/prepare-listing-submission-for-persist";
import {
  LISTING_DRAFT_AUTOSAVE_DEBOUNCE_MS,
  listingSubmissionFingerprint,
  listingWizardHasUnsavedInput,
} from "@/lib/manager-listing-draft-autosave";

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
  // The sheet asks bedrooms only; Basics owns the bathroom count. One bathroom
  // card from the start means the Rooms step never opens on "Add a bathroom first".
  const withBaths = applyListingBathroomSlots(withRooms.ok ? withRooms.sub : seeded);
  return normalizeManagerListingSubmissionV1(withBaths.ok ? withBaths.sub : withRooms.ok ? withRooms.sub : seeded);
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
  leadingStep,
  headerCenter,
  flushRef,
}: {
  onClose: () => void;
  /** After a flush save (X or debounce). `savedId` is the record written. */
  onSaved?: (sub: ManagerListingSubmissionV1, savedId?: string) => void;
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
  /** A caller-owned step before Basics — the import's Upload (see ListingEditorV2). */
  leadingStep?: ListingEditorLeadingStep;
  /** Header slot between the title and the save state — the import's property switcher. */
  headerCenter?: ReactNode;
  /**
   * Lets the caller save whatever is unsaved before it swaps this listing for
   * another one (the import's switcher). Resolves true when nothing was lost.
   */
  flushRef?: MutableRefObject<(() => Promise<boolean>) | null>;
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
  const [submission, setSubmission] = useState<ManagerListingSubmissionV1>(() => {
    const base = normalizeManagerListingSubmissionV1(initialSubmission ?? createDefaultListingSubmission());
    if (!(base.listingTotalBathroomsId ?? "").trim()) return base;
    const withBaths = applyListingBathroomSlots(base);
    return withBaths.ok ? withBaths.sub : base;
  });

  const label = submission.buildingName.trim() || submission.address.trim() || "New listing";
  const editing = Boolean(editListingId?.trim());

  const [paymentWaiverGranted, setPaymentWaiverGranted] = useState<boolean | null>(null);
  useEffect(() => {
    void loadManagerPaymentWaiverGrantedClient().then(setPaymentWaiverGranted);
  }, []);

  const submissionRef = useRef(submission);
  useEffect(() => {
    submissionRef.current = submission;
  }, [submission]);
  // Fingerprint the pre-sync submission so a stale draft (Basics said 3 baths,
  // one card on disk) is dirty and the next autosave writes the grown cards.
  const savedFingerprintRef = useRef(
    listingSubmissionFingerprint(
      initialSubmission
        ? normalizeManagerListingSubmissionV1(initialSubmission)
        : submission,
    ),
  );
  const stepRef = useRef(0);
  const closeTriesRef = useRef(0);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDirty(listingWizardHasUnsavedInput(submission, savedFingerprintRef.current));
  }, [submission]);
  // A draft opened by id was written before this editor opened (a resumed
  // draft, an imported property), so with nothing unsaved it IS saved.
  const saveState = busy ? "Saving…" : dirty ? "Unsaved changes" : editing || initialDraftId ? "Saved" : "Not saved yet";

  const persistSubmission = useCallback(async (
    raw: ManagerListingSubmissionV1,
  ): Promise<
    | { ok: true; submission: ManagerListingSubmissionV1; droppedMediaCount: number }
    | { ok: false; message: string }
  > => {
    try {
      const prepared = await prepareListingSubmissionForPersist(raw, {
        accountPaymentWaiverGranted: paymentWaiverGranted ?? undefined,
      });
      return { ok: true, ...prepared };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not prepare this listing to save.";
      return { ok: false, message };
    }
  }, [paymentWaiverGranted]);

  const persist = useCallback(
    async (raw: ManagerListingSubmissionV1, stepIndex: number): Promise<boolean> => {
      if (!listingWizardHasUnsavedInput(raw, savedFingerprintRef.current)) return true;
      const prepared = await persistSubmission(raw);
      if (!prepared.ok) {
        showToast?.(prepared.message);
        return false;
      }
      if (prepared.droppedMediaCount > 0) {
        setSubmission(prepared.submission);
        showToast?.("Some attachments could not upload and were removed.");
      }
      const result = editing
        ? await publish(prepared.submission)
        : await saveDraft(prepared.submission, stepIndex);
      if (!result.ok) {
        showToast?.(result.message);
        return false;
      }
      savedFingerprintRef.current = listingSubmissionFingerprint(prepared.submission);
      setDirty(listingWizardHasUnsavedInput(submissionRef.current, savedFingerprintRef.current));
      onSaved?.(prepared.submission, result.id);
      return true;
    },
    [editing, onSaved, persistSubmission, publish, saveDraft, showToast],
  );

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () => persist(submissionRef.current, stepRef.current);
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, persist]);

  useEffect(() => {
    if (!dirty) return;
    const handle = window.setTimeout(() => {
      void persist(submissionRef.current, stepRef.current);
    }, LISTING_DRAFT_AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [dirty, persist, submission]);

  const handleClose = useCallback(
    async (stepIndex: number) => {
      stepRef.current = stepIndex;
      const ok = await persist(submissionRef.current, stepIndex);
      if (ok) {
        closeTriesRef.current = 0;
        onClose();
        return;
      }
      closeTriesRef.current += 1;
      if (closeTriesRef.current >= 2) {
        showToast?.("Could not save. Nothing was kept.");
        onClose();
      }
    },
    [onClose, persist, showToast],
  );

  return (
    <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
      <ListingEditorV2
        title={label}
        submission={submission}
        onChange={setSubmission}
        onStepChange={(stepIndex) => {
          stepRef.current = stepIndex;
        }}
        onClose={(stepIndex) => {
          void handleClose(stepIndex);
        }}
        busy={busy}
        isEdit={editing}
        saveState={saveState}
        leadingStep={leadingStep}
        headerCenter={headerCenter}
        onPublish={async () => {
        const prepared = await persistSubmission(submission);
        if (!prepared.ok) {
          showToast?.(prepared.message);
          return;
        }
        if (prepared.droppedMediaCount > 0) {
          setSubmission(prepared.submission);
        }
        const result = await publish(prepared.submission);
        if (!result.ok) {
          showToast?.(result.message);
          return;
        }
        savedFingerprintRef.current = listingSubmissionFingerprint(prepared.submission);
        setDirty(false);
        if (prepared.droppedMediaCount > 0) {
          showToast?.("Published. Some attachments could not upload and were removed.");
        }
        onPublished?.(result.id);
      }}
    />
    </PortalAssistantConfigProvider>
  );
}
