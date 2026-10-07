"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/input";
import {
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PropertyHouseDetailsListPanel } from "@/components/portal/property-house-details-list-panel";
import { HouseInfoSplitReview } from "@/components/portal/house-info-split-review";
import { updateRequestChangeProperty } from "@/lib/demo-admin-property-inventory";
import {
  updateExtraListingFromSubmission,
  updatePendingManagerProperty,
} from "@/lib/demo-property-pipeline";
import {
  houseInfoIsEmpty,
  legacyHouseTextHasSplittableContent,
  normalizeHouseInfo,
  type HouseInfoV1,
} from "@/lib/house-info";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  getPortalListingNote,
  savePortalListingNote,
  type PortalListingNote,
} from "@/lib/portal-listing-notes";

/** Debounce before an edit is written. Long enough not to write per keystroke,
 *  short enough that switching tabs almost never has to flush. */
const HOUSE_DETAILS_AUTOSAVE_MS = 1200;

type HouseSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

type HouseDraft = {
  houseDescription: string;
  houseRulesText: string;
  generalHouseInfo: string;
  houseInfo: HouseInfoV1;
};

export function ManagerPropertyHouseDetailsPanel({
  noteKey,
  sub,
  saveTarget,
  managerUserId,
  onUpdated,
  propertyId,
  showToast,
}: {
  noteKey: string | null;
  sub: ManagerListingSubmissionV1;
  saveTarget: HouseSaveTarget;
  managerUserId: string | null;
  onUpdated: () => void;
  /** The server record id — what the print routes and the public QR link are keyed on. */
  propertyId?: string | null;
  showToast?: (message: string) => void;
}) {
  const [notesTick, setNotesTick] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [earlierNotesOpen, setEarlierNotesOpen] = useState(false);
  const [splitDismissed, setSplitDismissed] = useState(false);

  const portalNote = useMemo(
    () => (noteKey ? getPortalListingNote(noteKey) : ({} as PortalListingNote)),
    [noteKey, notesTick],
  );

  const baseline = useMemo<HouseDraft>(
    () => ({
      houseDescription: sub.houseDescription?.trim() || portalNote.houseDescription?.trim() || "",
      houseRulesText: sub.houseRulesText?.trim() || portalNote.houseRulesText?.trim() || "",
      generalHouseInfo: sub.generalHouseInfo?.trim() || portalNote.generalHouseInfo?.trim() || "",
      houseInfo: normalizeHouseInfo(sub.houseInfo ?? portalNote.houseInfo),
    }),
    [sub, portalNote],
  );

  const [draft, setDraft] = useState<HouseDraft>(baseline);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (!dirty) setDraft(baseline);
  }, [baseline, dirty]);

  // Latest draft, readable from inside a debounce/unmount callback without
  // making every one of them a dependency.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const persist = useCallback(
    (snapshot: HouseDraft, submission: ManagerListingSubmissionV1 = sub) => {
      if (!noteKey || !managerUserId) return false;
      setStatus("saving");
      const next: ManagerListingSubmissionV1 = {
        ...submission,
        houseDescription: snapshot.houseDescription ?? "",
        houseRulesText: snapshot.houseRulesText ?? "",
        generalHouseInfo: snapshot.generalHouseInfo ?? "",
        houseInfo: snapshot.houseInfo,
        // The structured Wi-Fi fields replaced this pair. Blanking them keeps a
        // stale password from outliving the one the manager is now editing.
        wifiNetworkName: "",
        wifiPassword: "",
      };
      let ok = false;
      if (saveTarget?.mode === "pending") {
        ok = updatePendingManagerProperty(saveTarget.saveId, next, managerUserId);
      } else if (saveTarget?.mode === "listing") {
        ok = updateExtraListingFromSubmission(saveTarget.saveId, managerUserId, next);
      } else if (saveTarget?.mode === "requestChange") {
        ok = updateRequestChangeProperty(saveTarget.saveId, managerUserId, next);
      }
      if (!ok) {
        // Stay dirty so the next keystroke retries. A failed autosave must never
        // look like a saved one — there is no button here to tell them otherwise.
        setStatus("error");
        return false;
      }
      savePortalListingNote(noteKey, {
        houseDescription: snapshot.houseDescription,
        houseRulesText: snapshot.houseRulesText,
        generalHouseInfo: snapshot.generalHouseInfo,
        houseInfo: snapshot.houseInfo,
      });
      // Only stop treating the form as dirty when nothing changed WHILE saving,
      // or a keystroke landing mid-save would never be written.
      if (JSON.stringify(draftRef.current) === JSON.stringify(snapshot)) {
        setDirty(false);
      }
      setStatus("saved");
      setNotesTick((t) => t + 1);
      onUpdated();
      return true;
    },
    [managerUserId, noteKey, onUpdated, saveTarget, sub],
  );

  // Debounced autosave. The manager asked for no Save button (AXI-164), so the
  // write has to happen on its own — and the status line below is then the only
  // thing telling them it did.
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => persist(draftRef.current), HOUSE_DETAILS_AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, persist]);

  // Flush on unmount — switching tabs or going Back inside the debounce window
  // would otherwise drop the last edit silently.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current = persist;
  }, [persist]);
  useEffect(() => {
    return () => {
      if (dirtyRef.current) persistRef.current(draftRef.current);
    };
  }, []);

  const legacy = useMemo(
    () => ({
      generalHouseInfo: draft.generalHouseInfo,
      houseRulesText: draft.houseRulesText,
      wifiNetworkName: sub.wifiNetworkName ?? "",
      wifiPassword: sub.wifiPassword ?? "",
    }),
    [draft.generalHouseInfo, draft.houseRulesText, sub.wifiNetworkName, sub.wifiPassword],
  );

  // Offer the split only while there is still free text worth splitting AND
  // nothing structured has been filled in — once they start using sections, a
  // banner about their old notes is just noise.
  const offerSplit =
    !splitDismissed && houseInfoIsEmpty(draft.houseInfo) && legacyHouseTextHasSplittableContent(legacy);

  if (!noteKey) return null;

  const updateText = (key: "houseDescription" | "houseRulesText" | "generalHouseInfo", value: string) => {
    setDirty(true);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  // The review screen has already folded the manager's keep-or-remove choice
  // into `info`, so applying is only: take it, remember what it replaced, and
  // clear the boxes it came out of.
  const applySplit = (info: HouseInfoV1) => {
    setDirty(true);
    setDraft((d) => ({
      ...d,
      houseInfo: {
        ...info,
        // Keep what the boxes held, so an unwanted split is recoverable from the
        // record rather than only from the manager's memory.
        migratedFrom: {
          at: new Date().toISOString(),
          generalHouseInfo: d.generalHouseInfo,
          houseRulesText: d.houseRulesText,
        },
      },
      generalHouseInfo: "",
      houseRulesText: "",
    }));
    setReviewOpen(false);
  };

  const statusText =
    status === "saving"
      ? "Saving…"
      : status === "error"
        ? "Couldn't save — check your connection"
        : dirty
          ? "Unsaved changes"
          : status === "saved"
            ? "Saved"
            : "";

  return (
    <PortalPropertyDetailSection>
      <div className="space-y-4">
        <PropertyHouseDetailsListPanel
          propertyId={propertyId ?? ""}
          sub={sub}
          houseInfo={draft.houseInfo}
          managerNotes={draft.houseDescription}
          statusNote={
            // No Save button (AXI-164) and no footer bar — but silence is not an option either. This quiet line
            // in the tools line is the ONLY signal that the typing is persisted, and the error state is the
            // only way a failed write is distinguishable from a saved one.
            statusText ? (
              <p
                className={status === "error" ? "text-[12.5px] font-medium text-red-600" : "text-[12.5px] text-muted/75"}
                role="status"
                aria-live="polite"
                data-attr="house-details-autosave-status"
              >
                {statusText}
              </p>
            ) : (
              <span role="status" aria-live="polite" data-attr="house-details-autosave-status" />
            )
          }
          splitOffer={offerSplit ? { onReview: () => setReviewOpen(true), onDismiss: () => setSplitDismissed(true) } : undefined}
          earlierNotes={
            draft.generalHouseInfo || draft.houseRulesText ? { onOpen: () => setEarlierNotesOpen(true) } : undefined
          }
          managerUserId={managerUserId}
          showToast={showToast}
          onPersist={(payload) => {
            setDirty(true);
            setDraft((d) => ({
              ...d,
              houseInfo: payload.houseInfo,
              houseDescription: payload.managerNotes,
            }));
            return persist(
              {
                houseDescription: payload.managerNotes,
                houseRulesText: draft.houseRulesText,
                generalHouseInfo: draft.generalHouseInfo,
                houseInfo: payload.houseInfo,
              },
              payload.sub,
            );
          }}
        />

      </div>

      {/* Studio: legacy free-text lives with Manager notes, not as a card under the list. */}
      <PortalDialog
        open={earlierNotesOpen}
        onClose={() => setEarlierNotesOpen(false)}
        title="Earlier notes"
        dataAttr="house-info-legacy"
        preview={null}
        primaryAction={{ label: "Done", onClick: () => setEarlierNotesOpen(false), dataAttr: "house-info-legacy-done" }}
      >
            <div className="space-y-3">
          {draft.generalHouseInfo ? (
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-muted">General house info</label>
              <Textarea
                rows={4}
                aria-label="General house info"
                value={draft.generalHouseInfo}
                onChange={(e) => updateText("generalHouseInfo", e.target.value)}
              />
            </div>
          ) : null}
          {draft.houseRulesText ? (
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-muted">House rules</label>
              <Textarea
                rows={4}
                aria-label="House rules"
                value={draft.houseRulesText}
                onChange={(e) => updateText("houseRulesText", e.target.value)}
              />
            </div>
          ) : null}
        </div>
      </PortalDialog>

      {reviewOpen ? (
        <HouseInfoSplitReview
          legacy={legacy}
          onCancel={() => setReviewOpen(false)}
          onApply={applySplit}
        />
      ) : null}
    </PortalPropertyDetailSection>
  );
}
