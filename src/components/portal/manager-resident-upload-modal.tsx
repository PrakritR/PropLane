"use client";

import { useEffect, useMemo, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Modal } from "@/components/ui/modal";

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
}: {
  open: boolean;
  residentName: string;
  defaultKind?: ResidentUploadDocKind;
  onClose: () => void;
  onUploaded: (files: File[], kinds: ResidentUploadDocKind[]) => Promise<void>;
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
    >
      <div className="space-y-4 px-1 pb-1">
        <label
          className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-secondary/30 px-4 py-8 text-center"
          data-attr="resident-upload-dropzone"
        >
          <Upload className="size-8 text-muted" strokeWidth={1.6} aria-hidden />
          <span className="text-sm font-semibold text-foreground">Drop files or choose</span>
          <input
            type="file"
            multiple
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const next = Array.from(e.target.files ?? []);
              setFiles(next);
              const kinds: Record<string, ResidentUploadDocKind> = {};
              for (const f of next) kinds[`${f.name}-${f.size}`] = kind;
              setPerFileKinds(kinds);
            }}
          />
        </label>
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
        <div className="flex justify-end gap-2 pt-2">
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
        </div>
      </div>
    </Modal>
  );
}
