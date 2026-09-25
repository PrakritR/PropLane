"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, PenLine, Plus, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { readLeaseTemplateFile } from "@/components/portal/lease-config-form";
import { leaseTemplateObjectPath } from "@/lib/lease-template-storage";
import {
  createLeaseDocumentLibraryEntry,
  deleteLeaseDocumentLibraryEntry,
  listLeaseDocumentLibrary,
  renameLeaseDocumentLibraryEntry,
  setDefaultLeaseDocumentLibraryEntry,
  updateLeaseDocumentLibraryFields,
  type LeaseDocumentLibraryEntry,
} from "@/lib/lease-document-library";
import { LeaseDocumentFieldEditorModal } from "@/components/portal/lease-document-field-editor-modal";

function leaseNameFromFileName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim() || "Lease document";
}

/** A per-row ⋯ that owns its own scope, same shape as the Payouts settings bank-account rows. */
function LibraryRowMenu({ rowId, label, children }: { rowId: string; label: string; children: ReactNode }) {
  return (
    <RecordActionContext.Provider value={{ scope: rowId, clear: () => {}, actions: children }}>
      <RecordActionMenu label={label} activate={() => {}} />
    </RecordActionContext.Provider>
  );
}

/**
 * Settings → Lease documents (night/custom-lease, item 1). A workspace-scoped
 * catalog of previously uploaded lease PDFs a property or lease can pick
 * instead of re-uploading. See `src/lib/lease-document-library.ts` and
 * `/api/portal/lease-library`.
 */
export function LeaseDocumentLibraryPanel() {
  const { workspaceId } = useSettingsPropertyScope();
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const [entries, setEntries] = useState<LeaseDocumentLibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [fieldEditorEntry, setFieldEditorEntry] = useState<LeaseDocumentLibraryEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await listLeaseDocumentLibrary(workspaceId || undefined));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not load the lease document library.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const onPickFile = useCallback(
    (file: File | null) => {
      readLeaseTemplateFile(
        file,
        (url, fileName) => {
          const storagePath = leaseTemplateObjectPath(url);
          if (!storagePath) {
            showToast("Could not save that upload to the library.");
            return;
          }
          void createLeaseDocumentLibraryEntry({
            storagePath,
            name: leaseNameFromFileName(fileName),
            fileName,
            workspaceId: workspaceId || undefined,
          })
            .then((entry) => {
              setEntries((prev) => [...prev, entry].sort((a, b) => a.name.localeCompare(b.name)));
              showToast("Lease document added to the library.");
            })
            .catch((err) => showToast(err instanceof Error ? err.message : "Could not add that document."));
        },
        showToast,
        setBusy,
      );
    },
    [showToast, workspaceId],
  );

  const startRename = (entry: LeaseDocumentLibraryEntry) => {
    setRenamingId(entry.id);
    setRenameDraft(entry.name);
  };

  const commitRename = async (id: string) => {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!name) return;
    try {
      const updated = await renameLeaseDocumentLibraryEntry(id, name);
      setEntries((prev) => prev.map((e) => (e.id === id ? updated : e)));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not rename that document.");
    }
  };

  const makeDefault = async (id: string) => {
    try {
      await setDefaultLeaseDocumentLibraryEntry(id);
      setEntries((prev) => prev.map((e) => ({ ...e, isDefault: e.id === id })));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not set the default.");
    }
  };

  const removeEntry = async (entry: LeaseDocumentLibraryEntry) => {
    if (!(await confirm({ description: `Remove "${entry.name}" from the library?` }))) return;
    try {
      await deleteLeaseDocumentLibraryEntry(entry.id);
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      showToast("Removed from the library.");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not remove that document.");
    }
  };

  const onFieldsSaved = (id: string, fields: LeaseDocumentLibraryEntry["fields"]) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, fields } : e)));
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <PortalSettingsSection
      title="Lease documents"
      action={
        <>
          <PortalIconAction
            icon={Plus}
            label="Upload a lease document"
            data-attr="lease-library-add"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              onPickFile(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
            data-attr="lease-library-file-input"
          />
        </>
      }
    >
      <PortalSettingsGroup>
        {loading ? (
          <div className="px-4 py-3.5 text-sm text-muted">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-3.5 text-sm text-muted">No lease documents in the library yet</div>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
              <div aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/[0.08] text-primary">
                <FileText className="size-5" strokeWidth={1.6} />
              </div>
              <div className="min-w-0 flex-1">
                {renamingId === entry.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => void commitRename(entry.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(entry.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm font-semibold text-foreground"
                    data-attr="lease-library-rename-input"
                  />
                ) : (
                  <p className="truncate text-sm font-semibold text-foreground">
                    {entry.name} {entry.isDefault ? <span className="font-normal text-muted">· Default</span> : null}
                  </p>
                )}
                <p className="mt-0.5 truncate text-xs text-muted">
                  {entry.fileName} {entry.fields.length > 0 ? `· ${entry.fields.length} signature field${entry.fields.length === 1 ? "" : "s"}` : ""}
                </p>
              </div>
              <LibraryRowMenu rowId={entry.id} label={entry.name}>
                <Button type="button" variant="outline" onClick={() => setFieldEditorEntry(entry)} data-attr="lease-library-place-fields">
                  <PenLine className="mr-1.5 size-3.5" strokeWidth={1.8} />
                  Place signature fields
                </Button>
                <Button type="button" variant="outline" onClick={() => startRename(entry)} data-attr="lease-library-rename">
                  Rename
                </Button>
                {!entry.isDefault ? (
                  <Button type="button" variant="outline" onClick={() => void makeDefault(entry.id)} data-attr="lease-library-default">
                    <Star className="mr-1.5 size-3.5" strokeWidth={1.8} />
                    Make default
                  </Button>
                ) : null}
                <Button type="button" variant="outline" onClick={() => void removeEntry(entry)} data-attr="lease-library-remove">
                  Remove
                </Button>
              </LibraryRowMenu>
            </div>
          ))
        )}
      </PortalSettingsGroup>
      {fieldEditorEntry ? (
        <LeaseDocumentFieldEditorModal
          entry={fieldEditorEntry}
          onClose={() => setFieldEditorEntry(null)}
          onSave={async (fields) => {
            const updated = await updateLeaseDocumentLibraryFields(fieldEditorEntry.id, fields);
            onFieldsSaved(fieldEditorEntry.id, updated.fields);
            setFieldEditorEntry(null);
            showToast("Signature fields saved.");
          }}
        />
      ) : null}
    </PortalSettingsSection>
  );
}

export { leaseNameFromFileName };
