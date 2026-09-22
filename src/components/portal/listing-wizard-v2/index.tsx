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
 * address and bedroom count sit right under them. X saves the draft (or the
 * live listing, when editing); typing does not start a timer. Publish is the
 * last section.
 *
 * `AddPropertyFlow` and {@link submissionFromAddProperty} are kept for callers
 * that already collected those answers elsewhere.
 *
 * It reads and writes the SAME `ManagerListingSubmissionV1` the existing wizard
 * uses, so drafts, normalization, validation, publishing and every downstream
 * reader are unchanged. Nothing here is a second source of truth for a listing.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ListingSaveFailedDialog } from "@/components/portal/listing-wizard-v2/save-failed-dialog";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { useListingContactSmsPhone } from "@/hooks/use-listing-contact-sms-phone";
import { useListingContactWorkEmail } from "@/hooks/use-listing-contact-work-email";
import { MANAGER_ASSISTANT_EMAIL_SETTINGS_HREF } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import type { AddPropertyResult } from "@/components/portal/listing-wizard-v2/add-property-flow";
import {
  ListingEditorV2,
  listingV2StepIndex,
  type ListingContactDoors,
  type ListingEditorLeadingStep,
  type ListingV2StepId,
} from "@/components/portal/listing-wizard-v2/listing-editor";
import { useListingPersistence, type ListingPersistenceResult } from "@/components/portal/listing-wizard-v2/use-listing-persistence";
import { fillRoomsFollowingDefaults, houseDefaultsForSubmission } from "@/lib/listing-house-defaults";
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
  listingSubmissionFingerprint,
  listingWizardHasUnsavedInput,
} from "@/lib/manager-listing-draft-autosave";
import { track } from "@/lib/analytics/track-client";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";

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
  basicsLead,
  onDirtyChange,
  flushRef,
  initialStep,
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
  /** Drawn on Basics ahead of Property type — Create's "Start from a file" strip. */
  basicsLead?: ReactNode;
  /** Whether the editor holds input that has not been saved yet — Create asks before a file replaces it. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Lets the caller save whatever is unsaved before it swaps this listing for
   * another one (the import's switcher). Resolves true when nothing was lost.
   */
  flushRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  /** Open the editor on this listing step (Import jumping to Rooms / Review). */
  initialStep?: ListingV2StepId;
}) {
  const { saveDraft, publish, busy: persistenceBusy } = useListingPersistence({
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
    const loaded = normalizeManagerListingSubmissionV1(initialSubmission ?? createDefaultListingSubmission());
    // A listing saved while the Pricing step blanked a room ticked "Same as
    // default room" holds $0 rent on that room although the card drew $1,050.
    // Fill such followers from the Default room once, on open; the pre-sync
    // fingerprint below makes the repair dirty, so autosave persists it.
    const rooms = fillRoomsFollowingDefaults(loaded.rooms ?? [], houseDefaultsForSubmission(loaded));
    const base = rooms === loaded.rooms ? loaded : { ...loaded, rooms: [...rooms] };
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
  const stepRef = useRef(listingV2StepIndex(initialStep));
  // Preparation uploads media before the persistence hook starts its own busy
  // state. Guard the entire lifecycle so two fast clicks cannot prepare stale
  // snapshots and resurrect a draft after a publish.
  const lifecycleRef = useRef(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const busy = persistenceBusy || lifecycleBusy;
  // `kind`/`limitInfo` ride along so the save-failed dialog can tell the
  // workspace's own record cap (a real "upgrade or manage drafts" way out)
  // apart from an ordinary transient refusal (`Try again` is the honest
  // option there). See `ListingPersistenceResult`.
  type SaveFailureDetails = Pick<Extract<ListingPersistenceResult, { ok: false }>, "message" | "kind" | "limitInfo">;
  const lastPersistErrorRef = useRef<SaveFailureDetails>({ message: "Could not save this listing." });
  const [saveFail, setSaveFail] = useState<(SaveFailureDetails & { stepIndex: number }) | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDirty(listingWizardHasUnsavedInput(submission, savedFingerprintRef.current));
  }, [submission]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Guard against reload while there is unsaved input (web only).
  useEffect(() => {
    if (!dirty || isNativeRuntimeSync()) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers show whatever string is set on returnValue.
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // A draft opened by id was written before this editor opened (a resumed
  // draft, an imported property), so with nothing unsaved it IS saved.
  const saveState = busy ? "Saving…" : dirty ? "Unsaved changes" : editing || initialDraftId ? "Saved" : "Not saved yet";

  const runLifecycle = useCallback(async (task: () => Promise<boolean>): Promise<boolean> => {
    if (lifecycleRef.current) return false;
    lifecycleRef.current = true;
    setLifecycleBusy(true);
    try {
      return await task();
    } finally {
      lifecycleRef.current = false;
      setLifecycleBusy(false);
    }
  }, []);

  const persistSubmission = useCallback(async (
    raw: ManagerListingSubmissionV1,
    opts?: { validateWaiverCode?: boolean },
  ): Promise<
    | { ok: true; submission: ManagerListingSubmissionV1; droppedMediaCount: number }
    | { ok: false; message: string }
  > => {
    try {
      const prepared = await prepareListingSubmissionForPersist(raw, {
        accountPaymentWaiverGranted: paymentWaiverGranted ?? undefined,
        validateWaiverCode: opts?.validateWaiverCode,
      });
      return { ok: true, ...prepared };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not prepare this listing to save.";
      return { ok: false, message };
    }
  }, [paymentWaiverGranted]);

  const persist = useCallback(
    async (
      raw: ManagerListingSubmissionV1,
      stepIndex: number,
      opts?: { notify?: boolean },
    ): Promise<boolean> => {
      const notify = opts?.notify !== false;
      if (!listingWizardHasUnsavedInput(raw, savedFingerprintRef.current)) return true;
      const prepared = await persistSubmission(raw, { validateWaiverCode: editing });
      if (!prepared.ok) {
        lastPersistErrorRef.current = { message: prepared.message };
        setActionError(prepared.message);
        if (notify) showToast?.(prepared.message);
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
        lastPersistErrorRef.current = { message: result.message, kind: result.kind, limitInfo: result.limitInfo };
        setActionError(result.message);
        if (notify) showToast?.(result.message);
        return false;
      }
      savedFingerprintRef.current = listingSubmissionFingerprint(prepared.submission);
      setActionError(null);
      setDirty(listingWizardHasUnsavedInput(submissionRef.current, savedFingerprintRef.current));
      onSaved?.(prepared.submission, result.id);
      return true;
    },
    [editing, onSaved, persistSubmission, publish, saveDraft, showToast],
  );

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () => runLifecycle(() => persist(submissionRef.current, stepRef.current));
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, persist, runLifecycle]);

  /**
   * The doors the listing will print — resolved exactly as the public page and
   * the manager's preview resolve them, so Review shows the renter's truth.
   * A live listing reads the catalog; a draft reads this manager's own account.
   */
  const contactPhone = useListingContactSmsPhone({
    listingId: editListingId,
    ownerManagerUserId: editListingOwnerUserId,
    viewerManagerUserId: userId,
  });
  const contactEmail = useListingContactWorkEmail({
    listingId: editListingId,
    ownerManagerUserId: editListingOwnerUserId,
    viewerManagerUserId: userId,
  });
  const openContactSettings = useCallback(async () => {
    // Settings is another page, so the draft is saved first — the same flush
    // the X performs — and the manager comes back to it from Drafts. A plain
    // navigation rather than the app router: the editor also mounts in tests
    // and hosts with no router, and this is a rare, deliberate leave.
    const ok = await runLifecycle(() => persist(submissionRef.current, stepRef.current));
    if (!ok) {
      showToast?.("Could not save. Nothing was kept.");
      return;
    }
    onClose();
    window.location.assign(MANAGER_ASSISTANT_EMAIL_SETTINGS_HREF);
  }, [onClose, persist, runLifecycle, showToast]);
  const contact = useMemo<ListingContactDoors>(
    () => ({
      phone: contactPhone,
      email: contactEmail,
      onSetUp: () => {
        void openContactSettings();
      },
    }),
    [contactPhone, contactEmail, openContactSettings],
  );

  const handleClose = useCallback(
    async (stepIndex: number) => {
      // PRP-486: a close reached while a save/publish is already in flight
      // (the ✕ still receives the click while `busy` is true, or a fast
      // double-close beats a click's own disabled state) used to return here
      // in total silence — no toast, no closed editor, nothing. The manager
      // had no way to tell their close did not register. Say the same thing
      // the header's own autosave status already says while busy.
      if (lifecycleRef.current) {
        showToast?.("Saving…");
        return;
      }
      stepRef.current = stepIndex;
      const ok = await runLifecycle(() => persist(submissionRef.current, stepIndex, { notify: false }));
      if (ok) {
        track("listing_editor_close_save", { editing });
        setSaveFail(null);
        onClose();
        return;
      }
      setSaveFail({ ...lastPersistErrorRef.current, stepIndex });
    },
    [editing, onClose, persist, runLifecycle, showToast],
  );

  // Explicit save is available from every V2 step. It keeps the editor open so
  // managers can safely continue after committing a partial draft.
  const handleSave = useCallback(
    async (stepIndex: number) => {
      stepRef.current = stepIndex;
      return runLifecycle(() => persist(submissionRef.current, stepIndex));
    },
    [persist, runLifecycle],
  );

  return (
    <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
      <>
      <ListingEditorV2
        title={label}
        propertyId={editListingId ?? initialDraftId ?? null}
        submission={submission}
        onChange={setSubmission}
        onStepChange={(stepIndex) => {
          stepRef.current = stepIndex;
        }}
        onClose={handleClose}
        onSave={handleSave}
        busy={busy}
        isEdit={editing}
        saveState={saveState}
        leadingStep={leadingStep}
        headerCenter={headerCenter}
        basicsLead={basicsLead}
        initialStep={initialStep}
        actionError={actionError}
        contact={contact}
        onPublish={() =>
          runLifecycle(async () => {
            const prepared = await persistSubmission(submissionRef.current, { validateWaiverCode: true });
            if (!prepared.ok) {
              setActionError(prepared.message);
              showToast?.(prepared.message);
              return false;
            }
            if (prepared.droppedMediaCount > 0) {
              setSubmission(prepared.submission);
            }
            const result = await publish(prepared.submission);
            if (!result.ok) {
              setActionError(result.message);
              // The workspace's own record cap refuses Publish exactly as it
              // refuses a draft save, and a toast is a dead end there. Route it
              // to the same upgrade prompt instead of only announcing it.
              if (result.kind === "plan_limit") {
                setSaveFail({
                  message: result.message,
                  kind: result.kind,
                  limitInfo: result.limitInfo,
                  stepIndex: stepRef.current,
                });
                return false;
              }
              showToast?.(result.message);
              return false;
            }
            savedFingerprintRef.current = listingSubmissionFingerprint(prepared.submission);
            setActionError(null);
            setDirty(false);
            if (prepared.droppedMediaCount > 0) {
              showToast?.("Published. Some attachments could not upload and were removed.");
            }
            onPublished?.(result.id);
            return true;
          })
        }
      />
      <ListingSaveFailedDialog
        open={saveFail !== null}
        reason={saveFail?.message ?? ""}
        kind={saveFail?.kind}
        limitInfo={saveFail?.limitInfo}
        onKeepEditing={() => setSaveFail(null)}
        onTryAgain={() => (saveFail ? handleClose(saveFail.stepIndex) : undefined)}
        onLeaveWithoutSaving={() => {
          track("listing_editor_leave_unsaved", { editing });
          setSaveFail(null);
          onClose();
        }}
      />
      </>
    </PortalAssistantConfigProvider>
  );
}
