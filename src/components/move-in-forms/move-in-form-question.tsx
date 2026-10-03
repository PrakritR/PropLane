"use client";

/**
 * ONE move-in form question, drawn as the input its type calls for. The builder's live
 * preview and the resident's fill flow both render through here, so what a manager sees
 * while building is exactly what a resident gets.
 *
 * Text, number, amount, yes/no, pick one, pick several, checkbox, date, phone, email and
 * initials all reuse the rental application's `CustomQuestionField` (the same controls the
 * application wizard draws). Photos and the signature are move-in specific: they upload
 * through the move-in forms client, never through the application's photo route.
 */
import { useState } from "react";
import { Camera, ImagePlus, X } from "lucide-react";
import { SignaturePad } from "@/components/move-in-forms/signature-pad";
import { CustomQuestionField } from "@/components/rental-application/custom-question-field";
import { FieldError, Label } from "@/components/rental-application/form-field-controls";
import { Button } from "@/components/ui/button";
import {
  answerToFieldString,
  fieldStringToAnswer,
  omitKey,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { useNativeCamera, type PhotoCaptureSource } from "@/lib/native/use-native-camera";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import type { MoveInFormAnswer, MoveInFormQuestion } from "@/lib/move-in-forms/types";

const MAX_PHOTOS = 12;

export type MoveInQuestionFieldProps = {
  question: MoveInFormQuestion;
  answer?: MoveInFormAnswer;
  onChange: (answer: MoveInFormAnswer | null) => void;
  error?: string;
  /** Submitted forms and the manager's read-only view: the control is drawn but cannot be changed. */
  readOnly?: boolean;
  /**
   * Stores a photo or the signature PNG and returns its storage path. Omitted in the builder's
   * preview, where nothing may be sent anywhere: picks then stay on the device.
   */
  uploadFile?: (file: Blob, fileName: string) => Promise<string>;
  /** Server-minted URL for a stored path, for thumbnails and the signature image. */
  fileUrl?: (storagePath: string) => string;
  /** The name recorded beside the signature. */
  signerName?: string;
};

export function MoveInFormQuestionField(props: MoveInQuestionFieldProps) {
  const { question } = props;
  if (question.type === "signature") return <SignatureQuestion {...props} />;
  if (question.type === "photos" || question.type === "file") return <PhotoQuestion {...props} />;
  return <TextishQuestion {...props} />;
}

function TextishQuestion({ question, answer, onChange, error, readOnly }: MoveInQuestionFieldProps) {
  return (
    <CustomQuestionField
      field={question as ManagerCustomApplicationField}
      value={answerToFieldString(question, answer)}
      error={error}
      readOnly={readOnly}
      onChange={(next) => onChange(fieldStringToAnswer(question, next))}
    />
  );
}

/* ───────────────────────────── photos ───────────────────────────── */

type PhotoRow = { path: string; preview?: string };

function PhotoQuestion({ question, answer, onChange, error, readOnly, uploadFile, fileUrl }: MoveInQuestionFieldProps) {
  const { capture } = useNativeCamera();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Object URLs minted from this device's own picks; a restored draft falls back to the server URL.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const stored = answer && "files" in answer ? answer.files : [];
  const rows: PhotoRow[] = stored.map((path) => ({ path, preview: previews[path] }));

  const commit = (paths: string[]) => {
    onChange(paths.length ? { key: question.key, files: paths } : null);
  };

  const add = async (source: PhotoCaptureSource) => {
    if (busy || readOnly) return;
    if (stored.length >= MAX_PHOTOS) {
      setProblem(`You can add up to ${MAX_PHOTOS} photos.`);
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const photo = await capture(source);
      if (!photo) return;
      if (uploadFile) {
        const path = await uploadFile(photo.file, photo.file.name || `photo-${Date.now()}.jpg`);
        setPreviews((prev) => ({ ...prev, [path]: photo.previewUrl }));
        commit([...stored, path]);
      } else {
        // Builder preview: keep the pick on this device only.
        const path = `preview:${Date.now()}`;
        setPreviews((prev) => ({ ...prev, [path]: photo.previewUrl }));
        commit([...stored, path]);
      }
    } catch (caught) {
      setProblem(caught instanceof Error && caught.message ? caught.message : "Could not add that photo. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = (path: string) => {
    const url = previews[path];
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    setPreviews((prev) => omitKey(prev, path));
    commit(stored.filter((item) => item !== path));
  };

  return (
    <div className="space-y-2" data-wizard-field={`custom:${question.key}`}>
      <Label required={question.required} optional={!question.required}>
        {question.label}
      </Label>
      {question.description ? <p className="text-xs text-muted">{question.description}</p> : null}
      {rows.length ? (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-attr="move-in-form-photos">
          {rows.map((row, index) => {
            const src = row.preview?.startsWith("blob:") ? row.preview : !row.path.startsWith("preview:") && fileUrl ? fileUrl(row.path) : null;
            return (
              <li key={row.path} className="relative aspect-square overflow-hidden rounded-xl border border-border bg-accent/40">
                {src ? (
                  // Blob URL minted on this device, or our own server-minted signed URL for a stored path.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src} alt={`Photo ${index + 1}`} className="h-full w-full object-cover" />
                ) : (
                  <span className="grid h-full w-full place-items-center text-xs text-muted">Photo {index + 1}</span>
                )}
                {!readOnly ? (
                  <button
                    type="button"
                    onClick={() => remove(row.path)}
                    aria-label={`Remove photo ${index + 1}`}
                    className="absolute right-1 top-1 grid size-7 place-items-center rounded-full bg-black/60 text-white transition-transform duration-(--motion-fast) hover:scale-105"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!readOnly ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="rounded-full" loading={busy} onClick={() => void add("camera")} data-attr="move-in-form-take-photo">
            <Camera className="size-4" aria-hidden />
            Take photo
          </Button>
          <Button type="button" variant="outline" className="rounded-full" disabled={busy} onClick={() => void add("files")} data-attr="move-in-form-choose-photos">
            <ImagePlus className="size-4" aria-hidden />
            Choose photos
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No photos.</p>
      ) : null}
      <FieldError msg={problem ?? error} />
    </div>
  );
}

/* ───────────────────────────── signature ───────────────────────────── */

function SignatureQuestion({ question, answer, onChange, error, readOnly, uploadFile, fileUrl, signerName }: MoveInQuestionFieldProps) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const signed = answer && "signature" in answer ? answer.signature : null;

  const adopt = async (png: Blob) => {
    setBusy(true);
    try {
      const storagePath = uploadFile ? await uploadFile(png, "signature.png") : `preview:${Date.now()}`;
      setPreview(URL.createObjectURL(png));
      onChange({
        key: question.key,
        signature: { storagePath, signedName: signerName?.trim() || "Resident", signedAt: new Date().toISOString() },
      });
    } finally {
      setBusy(false);
    }
  };

  const redo = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    onChange(null);
  };

  const imageSrc = preview ?? (signed && !signed.storagePath.startsWith("preview:") && fileUrl ? fileUrl(signed.storagePath) : null);

  return (
    <div className="space-y-2" data-wizard-field={`custom:${question.key}`}>
      <Label required optional={false}>
        {question.label}
      </Label>
      {question.description ? <p className="text-xs text-muted">{question.description}</p> : null}
      {signed ? (
        <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-attr="move-in-form-signed">
          {imageSrc ? (
            // Blob URL from this device's own pad, or the signature's server-minted signed URL.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageSrc} alt="Signature" className="mx-auto h-24 max-w-full object-contain" />
          ) : null}
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate font-medium text-foreground">Signed by {signed.signedName}</span>
            {!readOnly ? (
              <Button type="button" variant="ghost" className="rounded-full" onClick={redo} data-attr="move-in-form-signature-redo">
                Redo
              </Button>
            ) : null}
          </div>
        </div>
      ) : readOnly ? (
        <p className="text-sm text-muted">Not signed.</p>
      ) : (
        <SignaturePad onAdopt={adopt} busy={busy} dataAttr="move-in-form-signature" />
      )}
      <FieldError msg={error} />
    </div>
  );
}
