"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  settlePendingApplicationRowUpserts,
} from "@/lib/manager-applications-storage";
import {
  acceptForSlot,
  APPLICATION_DOCUMENTS_BUCKET,
  formatBytes,
  isAllowedApplicationPhotoMime,
  MAX_APPLICATION_PHOTO_BYTES,
  MAX_APPLICATION_PHOTO_SIZE_LABEL,
  validateApplicationPhotoUpload,
} from "@/lib/rental-application/application-photos";
import type { ApplicationPhotoAttachment, ApplicationPhotoSlot } from "@/lib/rental-application/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  APPLICATION_DOCUMENT_STORAGE_MIME,
  encryptApplicationDocumentUpload,
  type ApplicationDocumentUploadEncryption,
} from "@/lib/security/application-document-format";

const DISPLAYABLE_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

// A license stays legible at 2048px, and re-encoding a phone capture to JPEG at
// this edge keeps uploads to a few hundred KB. Small files skip the pass.
const DOWNSCALE_MAX_EDGE = 2048;
const DOWNSCALE_JPEG_QUALITY = 0.85;
const DOWNSCALE_SKIP_BYTES = 1_048_576;

type PreparedUpload = { blob: Blob; mimeType: string; fileName: string };

async function prepareFileForUpload(file: File): Promise<PreparedUpload> {
  const original: PreparedUpload = { blob: file, mimeType: file.type, fileName: file.name || "photo" };
  if (!file.type.startsWith("image/") || file.size <= DOWNSCALE_SKIP_BYTES) return original;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, DOWNSCALE_MAX_EDGE / Math.max(bitmap.width, bitmap.height, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", DOWNSCALE_JPEG_QUALITY),
    );
    if (!blob || blob.size === 0) return original;
    const base = (file.name || "").replace(/\.[A-Za-z0-9]+$/, "").trim() || "photo";
    return { blob, mimeType: "image/jpeg", fileName: `${base}.jpg` };
  } catch {
    // A format the browser can't decode (e.g. HEIC on desktop) uploads as-is —
    // the signed-URL transport carries it without a serverless body limit.
    return original;
  }
}

async function uploadApplicationPhoto(params: {
  applicationId: string;
  slot: ApplicationPhotoSlot;
  file: File;
  setupToken?: string | null;
}): Promise<{ ok: true; attachment: ApplicationPhotoAttachment } | { ok: false; error: string }> {
  if (params.file.type && !isAllowedApplicationPhotoMime(params.file.type, params.slot)) {
    return { ok: false, error: "That file type isn’t supported. Use a JPG, PNG, or PDF." };
  }
  const prepared = await prepareFileForUpload(params.file);
  if (prepared.blob.size > MAX_APPLICATION_PHOTO_BYTES) {
    return { ok: false, error: `That file is too large. Keep it under ${MAX_APPLICATION_PHOTO_SIZE_LABEL}.` };
  }
  const validated = validateApplicationPhotoUpload(params.slot, prepared.mimeType, prepared.blob.size);
  if (!validated.ok) return { ok: false, error: validated.error };
  try {
    const res = await fetch("/api/portal/application-photos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "sign",
        encryptionVersion: 1,
        applicationId: params.applicationId,
        slot: params.slot,
        fileName: prepared.fileName,
        mimeType: validated.mime,
        sizeBytes: prepared.blob.size,
        setupToken: params.setupToken || undefined,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      path?: string;
      token?: string;
      fileName?: string;
      error?: string;
      encryption?: ApplicationDocumentUploadEncryption;
    };
    if (!res.ok || !json.path || !json.token || !json.encryption) {
      return { ok: false, error: json.error || "Upload failed. Please try again." };
    }
    // Keep the one-object key only in this upload's memory. Only ciphertext goes
    // to Storage and only display/path metadata goes to autosave or callbacks.
    const encrypted = await encryptApplicationDocumentUpload(prepared.blob, json.path, json.encryption);
    delete json.encryption;
    const supabase = createSupabaseBrowserClient();
    const { error: uploadError } = await supabase.storage
      .from(APPLICATION_DOCUMENTS_BUCKET)
      .uploadToSignedUrl(json.path, json.token, encrypted, { contentType: APPLICATION_DOCUMENT_STORAGE_MIME });
    if (uploadError) return { ok: false, error: "Upload failed. Please try again." };
    return {
      ok: true,
      attachment: {
        storagePath: json.path,
        fileName: json.fileName || prepared.fileName,
        mimeType: validated.mime,
        sizeBytes: prepared.blob.size,
        uploadedAt: new Date().toISOString(),
      },
    };
  } catch {
    return { ok: false, error: "Upload failed — check your connection and try again." };
  }
}

async function deleteApplicationPhoto(params: {
  applicationId: string;
  storagePath: string;
  setupToken?: string | null;
}): Promise<void> {
  try {
    await fetch("/api/portal/application-photos", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        applicationId: params.applicationId,
        storagePath: params.storagePath,
        setupToken: params.setupToken || undefined,
      }),
    });
  } catch {
    // Best-effort: the reference is already gone from the form. A failed
    // byte-delete leaves an unreferenced object that is reclaimed only when the
    // application row itself is hard-deleted — there is no periodic sweep.
  }
}

function readUrlFor(applicationId: string, slot: ApplicationPhotoSlot, index: number): string {
  const params = new URLSearchParams({ applicationId, slot, index: String(index) });
  return `/api/portal/application-photos?${params.toString()}`;
}

/** Preview: freshly-captured objectURL when we have one, else the authorized read route. */
function AttachmentPreview({
  attachment,
  localPreview,
  readUrl,
}: {
  attachment: ApplicationPhotoAttachment;
  localPreview: string | null;
  readUrl: string;
}) {
  const [failed, setFailed] = useState(false);
  // Only render an <img> for browser-displayable formats. A HEIC/PDF (even one
  // just captured) would show a broken image, so it falls through to the chip —
  // as does a read-route fetch that can't be served (e.g. a guest with no
  // session after re-mount), via onError.
  if (DISPLAYABLE_IMAGE_MIME.has(attachment.mimeType) && (localPreview || !failed)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={localPreview ?? readUrl}
        alt={attachment.fileName}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-28 w-full rounded-lg border border-border object-cover [html[data-theme=dark]_&]:border-white/12"
      />
    );
  }
  return (
    <div className="flex h-28 w-full items-center justify-center rounded-lg border border-border bg-accent/30 text-center text-xs font-medium text-muted [html[data-theme=dark]_&]:border-white/12">
      <span className="px-3">
        {attachment.mimeType === "application/pdf" ? "PDF attached" : "File attached"}
        <br />
        {attachment.fileName}
      </span>
    </div>
  );
}

type SinglePhotoFieldProps = {
  slot: ApplicationPhotoSlot;
  index?: number;
  label: string;
  hint?: string;
  attachment: ApplicationPhotoAttachment | null;
  onChange: (next: ApplicationPhotoAttachment | null) => void;
  getApplicationId: () => string;
  /**
   * Guest (no-session) capture: uploads are authorized by the row's
   * resident-setup token, minted when the draft first persists. Until the token
   * exists the capture UI is replaced by an inline hint.
   */
  setupTokenRequired?: boolean;
  getSetupToken?: () => string | null;
  /** When true, hide camera capture and only offer file upload. */
  uploadOnly?: boolean;
  readOnly?: boolean;
  dataAttr?: string;
};

/** One capture-or-upload slot with preview, retake and remove. */
export function ApplicationPhotoField({
  slot,
  index = 0,
  label,
  hint,
  attachment,
  onChange,
  getApplicationId,
  setupTokenRequired,
  getSetupToken,
  uploadOnly = false,
  readOnly,
  dataAttr,
}: SinglePhotoFieldProps) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFailedFile, setLastFailedFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  // Revoke object URLs on unmount / change to avoid leaks.
  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  const handleFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return; // user cancelled the picker / camera — not an error
      setError(null);
      setBusy(true);
      const applicationId = getApplicationId();
      const previous = attachment;
      // A guest's token rotates with every autosave — drain the queue first so
      // the credential read below is the one the server currently holds.
      if (setupTokenRequired) await settlePendingApplicationRowUpserts(applicationId);
      const setupToken = getSetupToken?.() ?? null;
      const result = await uploadApplicationPhoto({ applicationId, slot, file, setupToken });
      if (!result.ok) {
        // A failed upload must never look like a success: leave the field as-is
        // and keep the file so Retry can re-run it.
        setError(result.error);
        setLastFailedFile(file);
        setBusy(false);
        return;
      }
      setLastFailedFile(null);
      const nextPreview = URL.createObjectURL(file);
      setLocalPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return nextPreview;
      });
      onChange(result.attachment);
      setBusy(false);
      // Retake: reclaim the object we just replaced (best-effort).
      if (previous?.storagePath && previous.storagePath !== result.attachment.storagePath) {
        void deleteApplicationPhoto({ applicationId, storagePath: previous.storagePath, setupToken });
      }
    },
    [attachment, getApplicationId, getSetupToken, onChange, setupTokenRequired, slot],
  );

  const handleRemove = useCallback(async () => {
    if (!attachment) return;
    setBusy(true);
    setError(null);
    const applicationId = getApplicationId();
    const removed = attachment;
    setLocalPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    onChange(null); // remove from the form immediately so it is never submitted
    if (removed.storagePath) {
      if (setupTokenRequired) await settlePendingApplicationRowUpserts(applicationId);
      await deleteApplicationPhoto({
        applicationId,
        storagePath: removed.storagePath,
        setupToken: getSetupToken?.() ?? null,
      });
    }
    setBusy(false);
  }, [attachment, getApplicationId, getSetupToken, onChange, setupTokenRequired]);

  // Only resolves (never mints) an id here — an attachment already implies one exists.
  const readUrl = attachment ? readUrlFor(getApplicationId(), slot, index) : "";

  return (
    <div className="space-y-2" data-attr={dataAttr}>
      <p className="text-sm font-semibold text-foreground">{label}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}

      {attachment ? (
        <div className="space-y-2">
          <AttachmentPreview attachment={attachment} localPreview={localPreview} readUrl={readUrl} />
          {!readOnly ? (
            <div className="flex flex-wrap gap-2">
              {!uploadOnly ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="px-4 text-[13px]"
                  disabled={busy}
                  onClick={() => cameraInputRef.current?.click()}
                  data-attr={dataAttr ? `${dataAttr}-retake` : undefined}
                >
                  {busy ? "Working…" : "Retake"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  className="px-4 text-[13px]"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                  data-attr={dataAttr ? `${dataAttr}-replace` : undefined}
                >
                  {busy ? "Uploading…" : "Upload file"}
                </Button>
              )}
              <Button
                type="button"
                variant="danger"
                className="px-4 text-[13px]"
                disabled={busy}
                onClick={handleRemove}
                data-attr={dataAttr ? `${dataAttr}-remove` : undefined}
              >
                Remove
              </Button>
            </div>
          ) : null}
        </div>
      ) : readOnly ? (
        <p className="text-sm text-muted">Not provided</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {!uploadOnly ? (
              <Button
                type="button"
                variant="secondary"
                className="px-4 text-[13px]"
                disabled={busy}
                onClick={() => cameraInputRef.current?.click()}
                data-attr={dataAttr ? `${dataAttr}-camera` : undefined}
              >
                {busy ? "Uploading…" : "Take photo"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              className="px-4 text-[13px]"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              data-attr={dataAttr ? `${dataAttr}-upload` : undefined}
            >
              {busy ? "Uploading…" : "Upload file"}
            </Button>
          </div>
        </div>
      )}

      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
          {lastFailedFile ? (
            <Button
              type="button"
              variant="secondary"
              className="px-4 text-[13px]"
              disabled={busy}
              onClick={() => handleFile(lastFailedFile)}
              data-attr={dataAttr ? `${dataAttr}-retry` : undefined}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Camera-first input (opens the camera on a phone). */}
      {!uploadOnly ? (
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      ) : null}
      {/* File picker (photo library or a file on desktop; PDF where allowed). */}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptForSlot(slot)}
        className="sr-only"
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

type IncomeProofPhotosProps = {
  attachments: ApplicationPhotoAttachment[];
  onChange: (next: ApplicationPhotoAttachment[]) => void;
  getApplicationId: () => string;
  setupTokenRequired?: boolean;
  getSetupToken?: () => string | null;
  uploadOnly?: boolean;
  readOnly?: boolean;
  max?: number;
};

/** A short list of proof-of-income documents built on {@link ApplicationPhotoField}. */
export function IncomeProofPhotos({
  attachments,
  onChange,
  getApplicationId,
  setupTokenRequired,
  getSetupToken,
  uploadOnly,
  readOnly,
  max = 3,
}: IncomeProofPhotosProps) {
  const list = Array.isArray(attachments) ? attachments : [];
  const canAddMore = !readOnly && list.length < max;

  return (
    <div className="space-y-3">
      {list.map((attachment, i) => (
        <ApplicationPhotoField
          key={attachment.storagePath || i}
          slot="income"
          index={i}
          label={`Document ${i + 1} · ${attachment.fileName}${
            attachment.sizeBytes ? ` (${formatBytes(attachment.sizeBytes)})` : ""
          }`}
          attachment={attachment}
          onChange={(next) => {
            const copy = [...list];
            if (next) copy[i] = next;
            else copy.splice(i, 1);
            onChange(copy);
          }}
          getApplicationId={getApplicationId}
          setupTokenRequired={setupTokenRequired}
          getSetupToken={getSetupToken}
          uploadOnly={uploadOnly}
          readOnly={readOnly}
          dataAttr="application-income-proof"
        />
      ))}
      {canAddMore ? (
        <ApplicationPhotoField
          key={`add-${list.length}`}
          slot="income"
          index={list.length}
          label={list.length === 0 ? "Add a pay stub, offer letter, or bank statement" : "Add another document"}
          attachment={null}
          onChange={(next) => {
            if (next) onChange([...list, next]);
          }}
          getApplicationId={getApplicationId}
          setupTokenRequired={setupTokenRequired}
          getSetupToken={getSetupToken}
          dataAttr="application-income-proof-add"
        />
      ) : null}
    </div>
  );
}
