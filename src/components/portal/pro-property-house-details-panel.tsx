"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/input";
import {
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { HouseInfoEditor } from "@/components/portal/house-info-sections";
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
  setHouseInfoValue,
  type HouseInfoSectionId,
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
}: {
  noteKey: string | null;
  sub: ManagerListingSubmissionV1;
  saveTarget: HouseSaveTarget;
  managerUserId: string | null;
  onUpdated: () => void;
}) {
  const [notesTick, setNotesTick] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
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
    (snapshot: HouseDraft) => {
      if (!noteKey || !managerUserId) return;
      setStatus("saving");
      const next: ManagerListingSubmissionV1 = {
        ...sub,
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
        return;
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

  const updateSection = (sectionId: HouseInfoSectionId, key: string, value: string) => {
    setDirty(true);
    setDraft((d) => ({ ...d, houseInfo: setHouseInfoValue(d.houseInfo, sectionId, key, value) }));
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

  return (
    <PortalPropertyDetailSection
      actions={
        // No Save button (AXI-164) — but silence is not an option either. With
        // the button gone this line is the ONLY signal that the typing is
        // persisted, and the error state is the only way a failed write is
        // distinguishable from a saved one.
        <p
          className={
            status === "error"
              ? "text-xs font-medium text-red-600"
              : "text-xs text-muted"
          }
          role="status"
          aria-live="polite"
          data-attr="house-details-autosave-status"
        >
          {status === "saving"
            ? "Saving…"
            : status === "error"
              ? "Couldn't save — check your connection"
              : dirty
                ? "Unsaved changes"
                : status === "saved"
                  ? "Saved"
                  : ""}
        </p>
      }
    >
      <div className="space-y-4">
        {offerSplit ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/35 bg-[var(--pl-accent-soft)] px-4 py-3"
            data-attr="house-info-split-banner"
          >
            <div className="min-w-[220px] flex-1">
              <p className="text-sm font-semibold text-foreground">We found details in your old notes</p>
              <p className="text-xs text-muted">
                Codes, Wi-Fi and rules look like they belong in the sections below. Nothing changes until you apply it.
              </p>
            </div>
            <button
              type="button"
              className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              onClick={() => setReviewOpen(true)}
              data-attr="house-info-split-review"
            >
              Review the split
            </button>
            <button
              type="button"
              className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-muted hover:text-foreground"
              onClick={() => setSplitDismissed(true)}
            >
              Not now
            </button>
          </div>
        ) : null}

        <HouseInfoEditor
          info={draft.houseInfo}
          onChange={updateSection}
          onOtherChange={(value) => {
            setDirty(true);
            setDraft((d) => ({ ...d, houseInfo: { ...d.houseInfo, other: value } }));
          }}
        />

        {/* Legacy free text. Present only while it still holds something, so a
            migrated house is not left with two empty boxes at the bottom. */}
        {draft.generalHouseInfo || draft.houseRulesText ? (
          <details
            className="overflow-hidden rounded-2xl border border-border bg-card"
            open={houseInfoIsEmpty(draft.houseInfo)}
            data-attr="house-info-legacy"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3">
              <span className="text-sm font-semibold text-foreground">Your earlier notes</span>
              <span className="portal-badge-info rounded-full px-2 py-0.5 text-[10px] font-semibold">Residents only</span>
            </summary>
            <div className="space-y-3 border-t border-border px-4 pb-4 pt-3">
              <p className="text-xs text-muted">
                Still shown to residents. Move it into the sections above and this goes away.
              </p>
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
          </details>
        ) : null}

        <details className="overflow-hidden rounded-2xl border border-border bg-card" data-attr="house-info-manager-notes">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3">
            <span className="text-sm font-semibold text-foreground">Manager notes</span>
            <span className="portal-badge-notice rounded-full px-2 py-0.5 text-[10px] font-semibold">Manager only</span>
          </summary>
          <div className="border-t border-border px-4 pb-4 pt-3">
            <p className="mb-3 text-xs text-muted">
              Never shown to a resident, never on a listing. Your own reminders about this house.
            </p>
            <Textarea
              rows={3}
              aria-label="Manager notes"
              value={draft.houseDescription}
              placeholder="Owner prefers text over calls. Boiler replaced March 2026."
              onChange={(e) => updateText("houseDescription", e.target.value)}
            />
          </div>
        </details>

        <div className="rounded-2xl border border-dashed border-border px-4 py-3">
          <p className="text-xs text-muted">
            Residents also see <b className="font-semibold text-foreground">How your portal works</b> — Services,
            Payments, Lease and Inbox. PropLane writes that for you; you do not need to type it here.
          </p>
        </div>
      </div>

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
