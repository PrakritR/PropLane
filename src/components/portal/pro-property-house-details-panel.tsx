"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/input";
import {
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { updateRequestChangeProperty } from "@/lib/demo-admin-property-inventory";
import {
  updateExtraListingFromSubmission,
  updatePendingManagerProperty,
} from "@/lib/demo-property-pipeline";
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

function FieldBlock({
  label,
  badge,
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  label: string;
  badge?: string | null;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows?: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-foreground">{label}</p>
        {badge ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              badge === "Manager only" ? "portal-badge-notice" : "portal-badge-info"
            }`}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <Textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="text-sm"
      />
    </div>
  );
}

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

  const portalNote = useMemo(
    () => (noteKey ? getPortalListingNote(noteKey) : ({} as PortalListingNote)),
    [noteKey, notesTick],
  );

  const baseline = useMemo(
    () => ({
      houseDescription: sub.houseDescription?.trim() || portalNote.houseDescription?.trim() || "",
      houseRulesText: sub.houseRulesText?.trim() || portalNote.houseRulesText?.trim() || "",
      generalHouseInfo: sub.generalHouseInfo?.trim() || portalNote.generalHouseInfo?.trim() || "",
    }),
    [sub, portalNote],
  );

  const [draft, setDraft] = useState(baseline);
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
    (snapshot: { houseDescription: string; houseRulesText: string; generalHouseInfo: string }) => {
      if (!noteKey || !managerUserId) return;
      setStatus("saving");
      const next: ManagerListingSubmissionV1 = {
        ...sub,
        houseDescription: snapshot.houseDescription ?? "",
        houseRulesText: snapshot.houseRulesText ?? "",
        generalHouseInfo: snapshot.generalHouseInfo ?? "",
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

  if (!noteKey) return null;

  const updateField = (key: keyof typeof draft, value: string) => {
    setDirty(true);
    setDraft((d) => ({ ...d, [key]: value }));
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
      <div className="space-y-6">
        <FieldBlock
        label="House description"
        badge="Manager only"
        value={draft.houseDescription}
        onChange={(v) => updateField("houseDescription", v)}
        placeholder="Internal notes about the house…"
      />
      <FieldBlock
        label="House rules"
        badge="Residents only"
        value={draft.houseRulesText}
        onChange={(v) => updateField("houseRulesText", v)}
        placeholder="Quiet hours, guests, smoking, pets…"
        rows={3}
      />
      <FieldBlock
        label="General house info"
        badge="Residents only"
        value={draft.generalHouseInfo}
        onChange={(v) => updateField("generalHouseInfo", v)}
        placeholder="Gate/door codes, laundry tips, trash schedule…"
      />
      </div>
    </PortalPropertyDetailSection>
  );
}
