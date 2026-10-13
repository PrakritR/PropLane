"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { fileToPromotionUpload } from "@/lib/promotion-upload";

export function PromotionUploadModal({
  open,
  onClose,
  onUpload,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onUpload: (file: File) => Promise<void>;
  busy?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setError(null);
    onClose();
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    const parsed = await fileToPromotionUpload(file);
    if (!parsed) {
      setError("Upload a JPG, PNG, or PDF up to 12 MB.");
      return;
    }
    await onUpload(file);
    close();
  };

  return (
    <Modal
      open={open}
      title="Upload promotion"
      description="Add your own flyer image or PDF. PropLane keeps it with this property's promotions."
      onClose={close}
      panelClassName="max-w-md"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            data-attr="promotion-upload-choose"
          >
            {busy ? "Uploading…" : "Choose file"}
          </Button>
        </ModalFooter>
      }
    >
      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-accent/20 px-4 py-10 text-center transition hover:border-primary/40">
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf,.pdf"
          className="hidden"
          data-attr="promotion-upload-input"
          onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
        />
        <span className="text-sm font-semibold text-foreground">Drop or click to upload</span>
      </label>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </Modal>
  );
}
