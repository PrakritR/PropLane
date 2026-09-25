"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { listLeaseDocumentLibrary, type LeaseDocumentLibraryEntry } from "@/lib/lease-document-library";

/**
 * Attach a workspace lease-library document to a resident's lease instead of
 * uploading a fresh file (night/custom-lease, item 1). Wraps
 * `managerAttachLibraryLeaseDocument` (`lease-pipeline-storage.ts`), which
 * carries over any signature fields placed on the library entry.
 */
export function LeaseAttachFromLibraryModal({
  open,
  onClose,
  onAttach,
}: {
  open: boolean;
  onClose: () => void;
  onAttach: (entry: LeaseDocumentLibraryEntry) => Promise<void>;
}) {
  const [entries, setEntries] = useState<LeaseDocumentLibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected("");
    setError(null);
    setLoading(true);
    void listLeaseDocumentLibrary()
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [open]);

  const attach = async () => {
    const entry = entries.find((e) => e.id === selected);
    if (!entry) {
      setError("Choose a lease document.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAttach(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach that document.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Attach from library"
      onClose={onClose}
      panelClassName="max-w-md"
      dismissBlocked={busy}
      footer={
        <ModalFooter>
          <Button type="button" variant="primary" className="rounded-full" disabled={busy || !selected} onClick={() => void attach()} data-attr="lease-attach-library-confirm">
            {busy ? "Attaching…" : "Attach"}
          </Button>
        </ModalFooter>
      }
    >
      {loading ? (
        <p className="text-sm text-muted">Loading library…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted">No lease documents in the workspace library yet. Add one from Settings → Lease documents.</p>
      ) : (
        <FieldSingleSelect
          label="Lease document"
          value={selected}
          onChange={setSelected}
          dataAttr="lease-attach-library-picker"
          options={entries.map((entry) => ({ value: entry.id, label: entry.name }))}
        />
      )}
      {error ? <p className="mt-2 text-xs font-medium text-red-600">{error}</p> : null}
    </Modal>
  );
}
