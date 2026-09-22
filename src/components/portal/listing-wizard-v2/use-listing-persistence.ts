"use client";

/**
 * Saving and publishing for the redesigned wizard.
 *
 * It deliberately calls the SAME server helpers the existing wizard uses —
 * `saveManagerPropertyDraftToServer`, `publishManagerPropertyDraftToServer` and
 * `submitManagerPendingPropertyToServer` — rather than inventing a second write
 * path. A listing created here is the same row, with the same id lineage, that
 * the old wizard would have produced, so a draft opens in either.
 *
 * Two behaviours are load-bearing and easy to lose:
 *
 * - **The plan limit is checked twice.** The pre-check here is a courtesy so a
 *   manager is told before their photos upload; it is NOT the limit. The server
 *   re-checks against its own count and plan, and its refusal is surfaced
 *   verbatim, because "Could not submit listing" reads as a broken button
 *   rather than as a limit with a way past it.
 * - **A draft keeps its id.** `draftId` is threaded through so saving twice
 *   updates one row instead of littering the Drafts tab, and publishing upgrades
 *   that same row rather than creating a second one beside it.
 */

import { useCallback, useRef, useState } from "react";
import { recordDelightMoment } from "@/lib/native/app-review";
import {
  publishManagerPropertyDraftToServer,
  saveManagerPropertyDraftToServer,
} from "@/lib/demo-admin-property-inventory";
import {
  submitManagerPendingPropertyToServer,
  updateExtraListingFromSubmissionOnServer,
} from "@/lib/demo-property-pipeline";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";
import { managerPropertyLimitMessage, managerTierPropertyLimitReached } from "@/lib/manager-access";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { PropertyRecordLimitInfo } from "@/lib/demo-property-pipeline";
import { listingSaveFailureMessage } from "@/lib/prepare-listing-submission-for-persist";
import { track } from "@/lib/analytics/track-client";
import { WORKSPACE_PROPERTY_LIMIT_ERROR_CODE } from "@/lib/workspaces/types";

/** Every reason `publish()` can refuse, for the `listing_publish_refused` event below. */
type PublishRefusedReason = "signed_out" | "plan_limit" | "server";

/**
 * Every publish refusal used to be silent past the toast — there was no
 * record of WHERE in the flow a manager stalled (never signed in, hit their
 * plan limit, or a genuine server refusal). Fired on every `{ ok: false }`
 * return below, never on success. No PII: reason is a fixed enum, message is
 * the same copy already shown in the UI, hasDraft is a boolean.
 */
function trackPublishRefused(reason: PublishRefusedReason, message: string, hasDraft: boolean): void {
  track("listing_publish_refused", { reason, message, hasDraft });
}

export type ListingPersistenceResult =
  | { ok: true; id: string }
  // `message` is toast copy (a full sentence); `reason` is the server's own
  // words, shown verbatim in the save-failed dialog. `reason` is "" when the
  // failure had no server explanation (a dropped connection, no session).
  //
  // `kind` distinguishes a refusal the save-failed dialog can offer a real way
  // past (the workspace's own record cap, `property_record_limit`) from an
  // ordinary transient one where "Try again" is the only honest option.
  // `limitInfo` carries whatever numbers the server gave for that cap; any
  // field may be missing (the dialog renders "unknown" facts as omitted, not
  // as a literal blank).
  | { ok: false; message: string; reason: string; kind?: "plan_limit"; limitInfo?: PropertyRecordLimitInfo };

export function useListingPersistence({
  userId,
  skuTier,
  propertyCount,
  initialDraftId = null,
  editListingId = null,
  editListingOwnerUserId = null,
}: {
  userId: string | null;
  /** Matches the portal's own loose plan type — the server is the authority. */
  skuTier: string | null | undefined;
  propertyCount: number;
  initialDraftId?: string | null;
  /**
   * The id of an existing LIVE listing being edited, rather than a new one
   * being created. Without it, saving an edit created a second listing beside
   * the one the manager opened.
   */
  editListingId?: string | null;
  /**
   * Who owns that listing. For a CO-MANAGED property the owner is somebody
   * else, and the write has to be made under their id — ownership is never
   * reassignable from a request body (see docs/agents/property-ownership.md),
   * so saving under the co-manager's own id is refused and the edit is lost.
   */
  editListingOwnerUserId?: string | null;
}) {
  const draftIdRef = useRef<string | null>(initialDraftId);
  const [busy, setBusy] = useState(false);

  const saveDraft = useCallback(
    async (submission: ManagerListingSubmissionV1, stepIndex: number): Promise<ListingPersistenceResult> => {
      if (!userId) return { ok: false, message: "Sign in to save this listing.", reason: "Sign in to save this listing." };
      setBusy(true);
      try {
        let serverReason = "";
        let serverCode: string | undefined;
        let serverLimitInfo: PropertyRecordLimitInfo | undefined;
        const savedId = await saveManagerPropertyDraftToServer(submission, userId, {
          existingDraftId: draftIdRef.current,
          stepIndex,
          maxStepReached: stepIndex,
          allowIdUpgrade: draftIdRef.current === null,
          onError: (message, code, _status, limitInfo) => {
            serverReason = message;
            serverCode = code;
            serverLimitInfo = limitInfo;
          },
        });
        if (!savedId) {
          // The workspace's own record cap (drafts included) is not a
          // transient failure "Try again" can ever clear — it is the SAME
          // refusal every time until a slot opens, so it gets its own kind
          // rather than the generic connection wording below.
          const isWorkspaceFull = serverCode === WORKSPACE_PROPERTY_LIMIT_ERROR_CODE;
          return {
            ok: false,
            message: serverReason
              ? `Could not save your progress — ${serverReason.replace(/\.$/, "")}. Your work is still here.`
              : "Could not save your progress. Check your connection. Your work is still here.",
            reason: serverReason || "Check your connection and try again.",
            kind: isWorkspaceFull ? "plan_limit" : undefined,
            limitInfo: isWorkspaceFull ? serverLimitInfo : undefined,
          };
        }
        draftIdRef.current = savedId;
        return { ok: true, id: savedId };
      } finally {
        setBusy(false);
      }
    },
    [userId],
  );

  const publish = useCallback(
    async (submission: ManagerListingSubmissionV1): Promise<ListingPersistenceResult> => {
      if (!userId) {
        const message = "Sign in to publish this listing.";
        trackPublishRefused("signed_out", message, Boolean(draftIdRef.current));
        return { ok: false, message, reason: message };
      }
      const editing = editListingId?.trim();
      if (editing) {
        // Editing an existing listing updates it IN PLACE. It consumes no new
        // plan slot, so the quota pre-check below is skipped deliberately — a
        // manager at their limit must still be able to fix a typo.
        setBusy(true);
        try {
          const ownerId = editListingOwnerUserId?.trim() || userId;
          // Same contract as `saveDraft` above: the server's own explanation
          // survives the trip back, and the connection wording is only the
          // fallback for a refusal that explained nothing.
          let serverReason = "";
          const ok = await updateExtraListingFromSubmissionOnServer(editing, ownerId, submission, {
            // A 4xx is a refusal the server explained and chose to expose; a
            // 5xx is raw database text and must not become manager-facing copy.
            onError: (message: string, _code?: string, status?: number) => {
              if (status != null && status >= 400 && status < 500) serverReason = message;
            },
          });
          if (ok) return { ok: true, id: editing };
          const message = listingSaveFailureMessage(serverReason);
          trackPublishRefused("server", message, Boolean(draftIdRef.current));
          return {
            ok: false,
            message,
            reason: serverReason || "Check your connection and try again.",
          };
        } finally {
          setBusy(false);
        }
      }
      // Courtesy pre-check only — the server is the authority and its refusal is
      // returned to the caller below.
      if (managerTierPropertyLimitReached(skuTier, propertyCount)) {
        const message = managerPropertyLimitMessage(skuTier, { omitUpgradeCta: isNativeRuntimeSync() });
        trackPublishRefused("plan_limit", message, Boolean(draftIdRef.current));
        return { ok: false, message, reason: message };
      }
      setBusy(true);
      try {
        let serverError = "";
        const opts = {
          onError: (message: string) => {
            serverError = message;
          },
        };
        const draftId = draftIdRef.current;
        const id = draftId
          ? await publishManagerPropertyDraftToServer(draftId, submission, userId, opts)
          : await submitManagerPendingPropertyToServer(submission, userId, opts);
        if (!id) {
          const message = serverError || "Could not publish this listing.";
          trackPublishRefused("server", message, Boolean(draftIdRef.current));
          return {
            ok: false,
            message,
            reason: serverError || "Check your connection and try again.",
          };
        }
        draftIdRef.current = null;
        recordDelightMoment("listing_published");
        return { ok: true, id };
      } finally {
        setBusy(false);
      }
    },
    [userId, skuTier, propertyCount, editListingId, editListingOwnerUserId],
  );

  /**
   * Forget the draft this hook has been updating, so the next save creates a
   * new row. A caller that lets a manager add a second property from the same
   * mounted hook needs this: without it the second property would silently
   * overwrite the first one's draft.
   */
  const startFresh = useCallback(() => {
    draftIdRef.current = null;
  }, []);

  return { saveDraft, publish, busy, draftId: draftIdRef, startFresh };
}
