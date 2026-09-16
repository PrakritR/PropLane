"use client";

/**
 * Create — the one door into a new listing, with the file import inside it.
 *
 * It opens the listing editor straight at Basics. Above Property type sits a
 * "Start from a file" strip: drop a spreadsheet, rent roll or PDF and PropLane
 * reads the whole file on the server and reports the properties it found. Each
 * becomes an ordinary listing draft on the spot (the same save path typing
 * uses, so ownership, the plan limit and autosave stay one code path).
 *
 * One property in the file replaces the blank listing in place — the manager is
 * already on Basics and stays there, now filled, with the file's marks on the
 * fields it set. Several fan out: the rail gains an Import step ahead of Basics
 * holding the Found list, and a switcher in the header moves between the
 * drafts, one property open at a time. Switching saves whatever is unsaved.
 *
 * Nothing lives in a second store: the drafts ARE the import, so the Drafts
 * tab is the resume point and there is no banner to dismiss.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import {
  ImportFileStrip,
  ImportUploadSidePanel,
  ImportUploadStep,
  stripStateFromRead,
  type ImportFoundEntry,
  type ImportReadState,
  type ImportStripState,
} from "@/components/portal/listing-wizard-v2/import-upload-step";
import { ImportPropertySwitcher } from "@/components/portal/listing-wizard-v2/import-property-switcher";
import { LISTING_V2_STEPS } from "@/components/portal/listing-wizard-v2/listing-editor";
import { ListingWorkspace, SideBelow, StepRail } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { deleteManagerPropertyDraft, saveManagerPropertyDraftToServer } from "@/lib/demo-admin-property-inventory";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { prepareListingSubmissionForPersist } from "@/lib/prepare-listing-submission-for-persist";
import { submissionFromImportedProperty } from "@/lib/property-import/to-submission";
import {
  PROPERTY_IMPORT_MAX_BYTES,
  type PropertyImportProperty,
  type PropertyImportReadResponse,
} from "@/lib/property-import/types";
import { track } from "@/lib/analytics/track-client";

const IMPORT_STEP_ID = "import";

type Entry = ImportFoundEntry & {
  submission: ManagerListingSubmissionV1;
  draftId: string | null;
};

/** The server's own reason a draft could not be written, or the connection fallback. */
function draftSaveFailure(serverReason: string): string {
  return serverReason ? serverReason.replace(/\.$/, "") : "Could not save this draft. Check your connection.";
}

/** Ask the server to read the file. The server never stores it. */
export async function readPropertyImportFile(file: File, hint?: string | null): Promise<PropertyImportReadResponse> {
  const form = new FormData();
  form.set("file", file);
  if (hint?.trim()) form.set("hint", hint.trim());
  try {
    const res = await fetch("/api/portal/property-import/read", { method: "POST", body: form, credentials: "same-origin" });
    const json = (await res.json().catch(() => null)) as PropertyImportReadResponse | null;
    if (json && typeof json === "object" && "ok" in json) return json;
    return { ok: false, error: "PropLane couldn't read that file just now. Try again in a moment.", code: "unreadable" };
  } catch {
    return { ok: false, error: "Couldn't reach PropLane. Check your connection and try again.", code: "unavailable" };
  }
}

/** Fold one understood property into another — two rows that were one house. */
export function mergeImportedProperties(from: PropertyImportProperty, into: PropertyImportProperty): PropertyImportProperty {
  const rooms = [...into.rooms, ...from.rooms];
  const rentedRooms = rooms.filter((r) => r.rent != null).length;
  return {
    ...into,
    rooms,
    bedrooms: Math.max(into.bedrooms, rooms.length),
    rentByRoom: into.rentByRoom || from.rentByRoom || rentedRooms >= 2,
    sourceRows: [...new Set([...into.sourceRows, ...from.sourceRows])].sort((a, b) => a - b),
    needsLook: [...new Set([...into.needsLook, ...from.needsLook])],
    confidence: into.confidence === "high" && from.confidence === "high" ? "high" : "medium",
  };
}

/** "Saving drafts…" / "Saved · 4 drafts" / "Saved · 2 of 4 drafts" / "Not saved yet". */
export function importSaveState(entries: ReadonlyArray<{ saving: boolean; draftId: string | null }>): string {
  if (entries.length === 0) return "Not saved yet";
  if (entries.some((e) => e.saving)) return "Saving drafts…";
  const saved = entries.filter((e) => e.draftId).length;
  if (saved === 0) return "Not saved";
  if (saved < entries.length) return `Saved · ${saved} of ${entries.length} drafts`;
  return `Saved · ${saved} draft${saved === 1 ? "" : "s"}`;
}

export function CreateWorkspace({
  onClose,
  onSaved,
  onDraftsChanged,
  onPublished,
  showToast,
  userId,
  skuTier,
  propertyCount = 0,
  initialSubmission = null,
  initialDraftId = null,
}: {
  onClose: () => void;
  /** The blank listing was saved (X or autosave) — before any file is involved. */
  onSaved?: (sub: ManagerListingSubmissionV1, savedId?: string) => void;
  /** Drafts were written, changed or removed — the Properties list should re-read. */
  onDraftsChanged?: () => void;
  /** A property went live. */
  onPublished?: (listingId: string) => void;
  showToast?: (message: string) => void;
  userId: string | null;
  skuTier: string | null | undefined;
  propertyCount?: number;
  /** Resuming a draft the manager started earlier. */
  initialSubmission?: ManagerListingSubmissionV1 | null;
  initialDraftId?: string | null;
}) {
  const [read, setRead] = useState<ImportReadState>({ kind: "empty" });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** blank: the editor on a listing typed by hand; import: the Found list; edit: one imported property open. */
  const [phase, setPhase] = useState<"blank" | "import" | "edit">("blank");
  const [busy, setBusy] = useState(false);
  /** A file picked while Basics already held typed work — waits for Replace / Keep. */
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const lastFileRef = useRef<File | null>(null);
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
  const blankDirtyRef = useRef(false);
  const blankDraftIdRef = useRef<string | null>(initialDraftId);

  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const saveEntryDraft = useCallback(
    async (entry: Entry): Promise<Entry> => {
      if (!userId) return { ...entry, saving: false, saveError: "Sign in to save this listing." };
      try {
        const prepared = await prepareListingSubmissionForPersist(entry.submission);
        let serverReason = "";
        const id = await saveManagerPropertyDraftToServer(prepared.submission, userId, {
          existingDraftId: entry.draftId,
          stepIndex: 0,
          maxStepReached: 0,
          allowIdUpgrade: entry.draftId === null,
          onError: (message) => {
            serverReason = message;
          },
        });
        if (!id) return { ...entry, submission: prepared.submission, saving: false, saveError: draftSaveFailure(serverReason) };
        return { ...entry, submission: prepared.submission, draftId: id, saving: false, saveError: null };
      } catch (err) {
        return { ...entry, saving: false, saveError: draftSaveFailure(err instanceof Error ? err.message : "") };
      }
    },
    [userId],
  );

  /** Turn what the model found into drafts, one save at a time so the list fills in as it goes. */
  const adoptUnderstanding = useCallback(
    async (properties: PropertyImportProperty[]) => {
      const fresh: Entry[] = properties.map((property) => ({
        key: property.key,
        property,
        submission: submissionFromImportedProperty(property),
        draftId: null,
        saving: true,
        saveError: null,
      }));
      setEntries(fresh);
      setSelectedKey(fresh[0]?.key ?? null);
      let firstFailure: string | null = null;
      let failed = 0;
      for (const entry of fresh) {
        const saved = await saveEntryDraft(entry);
        if (!saved.draftId) {
          failed += 1;
          firstFailure ??= saved.saveError ?? null;
        }
        setEntries((prev) => prev.map((e) => (e.key === saved.key ? saved : e)));
      }
      onDraftsChanged?.();
      // The server's refusal (the plan limit, most often) reaches the manager
      // in its own words, never as a generic "could not save".
      if (failed > 0) showToast?.(`${failed} of ${fresh.length} could not be saved as a draft — ${firstFailure ?? "check your connection"}.`);
    },
    [onDraftsChanged, saveEntryDraft, showToast],
  );

  const runRead = useCallback(
    async (file: File, hint: string | null) => {
      if (file.size > PROPERTY_IMPORT_MAX_BYTES) {
        setRead({ kind: "error", fileName: null, message: `${file.name} is over 5 MB. Export a smaller sheet, or split it.` });
        return;
      }
      const previous = read;
      lastFileRef.current = file;
      setBusy(true);
      setRead({ kind: "reading", fileName: file.name });
      const res = await readPropertyImportFile(file, hint);
      setBusy(false);
      if (!res.ok) {
        // A re-read that fails keeps what the first read found.
        if (hint && previous.kind === "found") {
          setRead(previous);
          showToast?.(res.error);
          return;
        }
        setRead({ kind: "error", fileName: file.name, message: res.error });
        return;
      }
      // Nothing in the file looked like a property: say so where the file was
      // dropped, in PropLane's own words, and leave Basics as it was. Moving
      // to an empty Found list would strand the manager on a step with nothing
      // on it and Continue off.
      if (res.understanding.properties.length === 0 && phase === "blank") {
        const why = res.understanding.summary[0] ?? "No addresses, rents or units were found in it.";
        setRead({ kind: "error", fileName: file.name, message: why });
        return;
      }
      // A re-read replaces the previous batch: drop drafts the old read made.
      const stale = entriesRef.current.filter((e) => e.draftId);
      if (stale.length > 0 && userId) {
        await Promise.all(stale.map((e) => deleteManagerPropertyDraft(e.draftId!, userId).catch(() => false)));
      }
      // The listing typed by hand gives way to the file: its draft goes too, or
      // the Drafts tab would show an orphan next to what the file produced.
      const blankDraftId = blankDraftIdRef.current;
      if (blankDraftId && userId) {
        blankDraftIdRef.current = null;
        await deleteManagerPropertyDraft(blankDraftId, userId).catch(() => false);
      }
      setRead({ kind: "found", understanding: res.understanding });
      track("property_import_opened", { propertyCount: res.understanding.properties.length });
      await adoptUnderstanding(res.understanding.properties);
      // One property fills this listing in place; several become the Found list.
      const [only] = res.understanding.properties;
      if (res.understanding.properties.length === 1 && only) {
        setSelectedKey(only.key);
        setPhase("edit");
      } else {
        setPhase("import");
      }
    },
    [adoptUnderstanding, phase, read, showToast, userId],
  );

  const onPickFile = useCallback((file: File) => void runRead(file, null), [runRead]);
  /** From Basics: a file picked over typed work waits for the manager's word. */
  const onPickFileFromBasics = useCallback(
    (file: File) => {
      if (blankDirtyRef.current || blankDraftIdRef.current) {
        setPendingFile(file);
        return;
      }
      void runRead(file, null);
    },
    [runRead],
  );
  const confirmReplace = useCallback(() => {
    const file = pendingFile;
    setPendingFile(null);
    if (file) void runRead(file, null);
  }, [pendingFile, runRead]);
  const keepTyped = useCallback(() => setPendingFile(null), []);
  const onReread = useCallback(
    (hint: string) => {
      const file = lastFileRef.current;
      if (!file) return;
      void runRead(file, hint);
    },
    [runRead],
  );

  /** Save whatever the open editor holds before it is swapped out or closed. */
  const flushOpenEditor = useCallback(async (): Promise<boolean> => {
    const flush = flushRef.current;
    if (!flush) return true;
    return flush();
  }, []);

  const openEntry = useCallback(
    async (key: string) => {
      if (phase === "edit" && key !== selectedKey) {
        const ok = await flushOpenEditor();
        if (!ok) {
          showToast?.("Could not save this property yet. Try again.");
          return;
        }
      }
      setSelectedKey(key);
      setPhase("edit");
    },
    [flushOpenEditor, phase, selectedKey, showToast],
  );

  const backToImport = useCallback(async () => {
    const ok = await flushOpenEditor();
    if (!ok) {
      showToast?.("Could not save this property yet. Try again.");
      return;
    }
    setPhase("import");
  }, [flushOpenEditor, showToast]);

  const removeEntry = useCallback(
    async (key: string) => {
      const entry = entriesRef.current.find((e) => e.key === key);
      if (!entry) return;
      if (entry.draftId && userId) await deleteManagerPropertyDraft(entry.draftId, userId).catch(() => false);
      setEntries((prev) => {
        const next = prev.filter((e) => e.key !== key);
        setSelectedKey((sel) => (sel === key ? next[0]?.key ?? null : sel));
        return next;
      });
      onDraftsChanged?.();
    },
    [onDraftsChanged, userId],
  );

  const mergeEntries = useCallback(
    async (fromKey: string, intoKey: string) => {
      const from = entriesRef.current.find((e) => e.key === fromKey);
      const into = entriesRef.current.find((e) => e.key === intoKey);
      if (!from || !into || fromKey === intoKey) return;
      const property = mergeImportedProperties(from.property, into.property);
      const merged: Entry = { ...into, property, submission: submissionFromImportedProperty(property), saving: true };
      setEntries((prev) => prev.filter((e) => e.key !== fromKey).map((e) => (e.key === intoKey ? merged : e)));
      setSelectedKey((sel) => (sel === fromKey ? intoKey : sel));
      if (from.draftId && userId) await deleteManagerPropertyDraft(from.draftId, userId).catch(() => false);
      const saved = await saveEntryDraft(merged);
      setEntries((prev) => prev.map((e) => (e.key === intoKey ? saved : e)));
      onDraftsChanged?.();
    },
    [onDraftsChanged, saveEntryDraft, userId],
  );

  const selected = entries.find((e) => e.key === selectedKey) ?? entries[0] ?? null;
  const needLook = entries.filter((e) => e.property.needsLook.length > 0).length;
  const fileName = read.kind === "found" ? read.understanding.fileName : read.kind === "reading" ? read.fileName : null;

  const switcherEntries = useMemo(
    () =>
      entries.map((e) => {
        const p = e.property;
        const model = p.rentByRoom || p.rooms.filter((r) => r.rent != null).length >= 2 ? "by the room" : "whole place";
        const count = p.rooms.length > 0 ? `${p.rooms.length} ${p.rentByRoom ? "room" : "unit"}${p.rooms.length === 1 ? "" : "s"}` : `${p.bedrooms} bed`;
        return {
          key: e.key,
          label: e.submission.buildingName.trim() || e.submission.address.trim() || p.name || p.address,
          detail: [[p.city, p.state].filter(Boolean).join(", "), count, model].filter(Boolean).join(" · "),
          needsLook: p.needsLook,
        };
      }),
    [entries],
  );

  const importSummary = fileName ? `${fileName}${entries.length ? ` · ${entries.length} found` : ""}` : "Choose a file";
  const leadingStep = useMemo(
    () => ({
      id: IMPORT_STEP_ID,
      label: "Import",
      summary: importSummary,
      attention: needLook,
      onOpen: () => void backToImport(),
    }),
    [backToImport, importSummary, needLook],
  );

  if (phase === "blank") {
    const stripState: ImportStripState = pendingFile ? { kind: "confirm", fileName: pendingFile.name } : (stripStateFromRead(read) ?? { kind: "blank" });
    return (
      <ListingWizardV2
        key="blank"
        onClose={onClose}
        onSaved={(sub, savedId) => {
          if (savedId) blankDraftIdRef.current = savedId;
          onSaved?.(sub, savedId);
        }}
        onPublished={onPublished}
        initialSubmission={initialSubmission}
        initialDraftId={initialDraftId}
        showToast={showToast}
        userId={userId}
        skuTier={skuTier}
        propertyCount={propertyCount}
        onDirtyChange={(dirty) => {
          blankDirtyRef.current = dirty;
        }}
        basicsLead={
          <ImportFileStrip
            state={stripState}
            busy={busy}
            onPickFile={onPickFileFromBasics}
            onReread={onReread}
            onConfirm={confirmReplace}
            onCancel={keepTyped}
          />
        }
      />
    );
  }

  if (phase === "edit" && selected) {
    return (
      <ListingWizardV2
        key={selected.key}
        onClose={onClose}
        onSaved={(sub, savedId) => {
          setEntries((prev) => prev.map((e) => (e.key === selected.key ? { ...e, submission: sub, draftId: savedId ?? e.draftId } : e)));
          onDraftsChanged?.();
        }}
        onPublished={(listingId) => {
          const remaining = entriesRef.current.filter((e) => e.key !== selected.key);
          setEntries(remaining);
          onDraftsChanged?.();
          if (remaining.length === 0) {
            onPublished?.(listingId);
            return;
          }
          showToast?.(`Published. ${remaining.length} more from ${fileName ?? "your file"} still in Drafts.`);
          setSelectedKey(remaining[0]!.key);
          setPhase("import");
        }}
        initialSubmission={selected.submission}
        initialDraftId={selected.draftId}
        showToast={showToast}
        userId={userId}
        skuTier={skuTier}
        propertyCount={propertyCount}
        leadingStep={leadingStep}
        headerCenter={
          entries.length > 1 ? (
            <ImportPropertySwitcher entries={switcherEntries} selectedKey={selected.key} onSelect={(key) => void openEntry(key)} disabled={busy} />
          ) : undefined
        }
        flushRef={flushRef}
      />
    );
  }

  // The Import step, drawn on the same shell the editor uses — same header,
  // rail, footer — so stepping into Basics changes nothing but the body.
  const railSteps = [
    { id: IMPORT_STEP_ID, label: "Import", summary: importSummary, attention: needLook },
    ...LISTING_V2_STEPS.map((s) => ({ id: s.id, label: s.label, offPath: entries.length === 0 })),
  ];
  const canContinue = entries.length > 0 && !busy;
  const sidePanel = <ImportUploadSidePanel state={read} draftCount={entries.length} />;

  return (
    <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
      <ListingWorkspace
        title="New listing"
        subtitle={fileName ?? undefined}
        saveState={importSaveState(entries)}
        onClose={onClose}
        headerCenter={
          entries.length > 1 && selected ? (
            <ImportPropertySwitcher entries={switcherEntries} selectedKey={selected.key} onSelect={(key) => void openEntry(key)} disabled={busy} />
          ) : null
        }
        rail={
          <StepRail
            steps={railSteps}
            current={0}
            onJump={(index) => {
              if (index === 0 || !selected) return;
              void openEntry(selected.key);
            }}
          />
        }
        sidePanel={sidePanel}
        footer={
          <>
            <div className="flex items-center gap-2.5">
              <button type="button" disabled className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground disabled:opacity-45">
                Back
              </button>
            </div>
            <span className="hidden text-[12.5px] text-muted sm:inline">Step 1 of {LISTING_V2_STEPS.length + 1}</span>
            <button
              type="button"
              disabled={!canContinue}
              onClick={() => selected && void openEntry(selected.key)}
              data-attr="import-upload-continue"
              className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-60"
            >
              <span className="sm:hidden">Continue</span>
              <span className="hidden sm:inline">Continue to Basics</span>
            </button>
          </>
        }
      >
        <ImportUploadStep
          state={read}
          entries={entries}
          onPickFile={onPickFile}
          onReread={onReread}
          onOpen={(key) => void openEntry(key)}
          onRemove={(key) => void removeEntry(key)}
          onMerge={(from, into) => void mergeEntries(from, into)}
          busy={busy}
        />
        <SideBelow>{sidePanel}</SideBelow>
      </ListingWorkspace>
    </PortalAssistantConfigProvider>
  );
}
