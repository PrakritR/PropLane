"use client";

import { useEffect, useMemo, useState } from "react";
import { FileUp } from "lucide-react";
import { DOCUMENT_FILE_CHIPS, WorkspaceFileCard } from "@/components/portal/add-workspace/upload-action";
import { DOCUMENT_UPLOAD_ACCEPT } from "@/lib/documents/manager-documents";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Modal, ModalFooter } from "@/components/ui/modal";

export type ResidentUploadDocKind =
  | "application"
  | "lease"
  | "payment"
  | "inspection"
  | "other";

const KIND_OPTIONS: Array<{ value: ResidentUploadDocKind; label: string }> = [
  { value: "application", label: "Application" },
  { value: "lease", label: "Lease" },
  { value: "payment", label: "Payment" },
  { value: "inspection", label: "Inspection" },
  { value: "other", label: "Other" },
];

export function ManagerResidentUploadModal({
  open,
  residentName,
  defaultKind = "other",
  onClose,
  onUploaded,
  onReadForResident,
}: {
  open: boolean;
  residentName: string;
  defaultKind?: ResidentUploadDocKind;
  onClose: () => void;
  onUploaded: (files: File[], kinds: ResidentUploadDocKind[]) => Promise<void>;
  /** A second door on the Start from a file card: close this and read a filled application or lease PDF into the record instead. */
  onReadForResident?: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<ResidentUploadDocKind>(defaultKind);
  const [perFileKinds, setPerFileKinds] = useState<Record<string, ResidentUploadDocKind>>({});
  const [busy, setBusy] = useState(false);

  const title = useMemo(() => `Upload for ${residentName}`, [residentName]);

  useEffect(() => {
    if (open) setKind(defaultKind);
  }, [open, defaultKind]);

  const reset = () => {
    setFiles([]);
    setKind(defaultKind);
    setPerFileKinds({});
    setBusy(false);
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={() => {
        if (busy) return;
        reset();
        onClose();
      }}
      dataAttr="resident-upload-modal"
      contextPanel={null}
      preview={null}
      footer={
        <ModalFooter>
          <Button
            type="button"
            disabled={files.length === 0 || busy}
            onClick={() => {
              void (async () => {
                const resolved = files.map(
                  (f) => perFileKinds[`${f.name}-${f.size}`] ?? kind,
                );
                setBusy(true);
                try {
                  await onUploaded(files, resolved);
                  reset();
                  onClose();
                } finally {
                  setBusy(false);
                }
              })();
            }}
            data-attr="resident-upload-submit"
          >
            {busy ? "Uploading…" : "Upload"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <WorkspaceFileCard
          accept={DOCUMENT_UPLOAD_ACCEPT}
          chips={DOCUMENT_FILE_CHIPS}
          dataAttr="resident-upload-dropzone"
          disabled={busy}
          onPick={() => undefined}
          onPickMany={(next) => {
            setFiles(next);
            const kinds: Record<string, ResidentUploadDocKind> = {};
            for (const f of next) kinds[`${f.name}-${f.size}`] = kind;
            setPerFileKinds(kinds);
          }}
          extraItems={onReadForResident ? [{
            label: "Read a filled application or lease",
            icon: FileUp,
            dataAttr: "resident-upload-for-resident",
            onSelect: () => {
              reset();
              onClose();
              onReadForResident();
            },
          }] : undefined}
        />
        {files.length > 0 ? (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {files.map((file) => {
              const key = `${file.name}-${file.size}`;
              return (
                <li key={key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="truncate text-sm font-medium">{file.name}</span>
                  <FieldSingleSelect
                    label="Type"
                    value={perFileKinds[key] ?? kind}
                    options={KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    onChange={(value: string) =>
                      setPerFileKinds((prev) => ({ ...prev, [key]: value as ResidentUploadDocKind }))
                    }
                    dataAttr={`resident-upload-type-${key}`}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}
