"use client";

import { useState } from "react";
import { UploadedLeasePdfPreview } from "@/components/portal/uploaded-lease-pdf-preview";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { formatBytes } from "@/lib/rental-application/application-photos";
import type { ApplicationPhotoAttachment, ApplicationPhotoSlot } from "@/lib/rental-application/types";

/**
 * Manager-side read of an applicant's ID / income photos. The bytes are served
 * only by `/api/portal/application-photos`, which re-authorizes every request
 * against the calling manager's property access — an `<img>`/link here carries
 * the manager's session cookie, so one manager can never load another's
 * applicants' photos even by crafting the URL.
 */

const BROWSER_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHONE_IMAGE_MIME = new Set(["image/heic", "image/heif"]);

function photoUrl(
  applicationId: string,
  slot: ApplicationPhotoSlot,
  index: number,
  opts?: { preview?: boolean },
): string {
  const params = new URLSearchParams({ applicationId, slot, index: String(index) });
  if (opts?.preview) params.set("preview", "1");
  return `/api/portal/application-photos?${params.toString()}`;
}

function isPdfAttachment(attachment: ApplicationPhotoAttachment): boolean {
  return (
    attachment.mimeType === "application/pdf" ||
    attachment.fileName.toLowerCase().endsWith(".pdf")
  );
}

function isInlineImageAttachment(attachment: ApplicationPhotoAttachment): boolean {
  if (isPdfAttachment(attachment)) return false;
  if (BROWSER_IMAGE_MIME.has(attachment.mimeType)) return true;
  if (PHONE_IMAGE_MIME.has(attachment.mimeType)) return true;
  return /\.(jpe?g|png|webp|heic|heif)$/i.test(attachment.fileName);
}

function PhotoPreview({
  applicationId,
  slot,
  index,
  label,
  attachment,
}: {
  applicationId: string;
  slot: ApplicationPhotoSlot;
  index: number;
  label: string;
  attachment: ApplicationPhotoAttachment;
}) {
  const [failed, setFailed] = useState(false);
  const previewUrl = photoUrl(applicationId, slot, index, { preview: true });
  const openUrl = photoUrl(applicationId, slot, index);
  const meta = (
    <p className="truncate text-[11px] text-muted/80" title={attachment.fileName}>
      {attachment.fileName}
      {attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
    </p>
  );

  if (isPdfAttachment(attachment)) {
    return (
      <div className="space-y-1.5" data-attr="application-verification-photo">
        <p className="text-xs font-medium text-muted">{label}</p>
        <div className="overflow-hidden rounded-lg border border-border bg-card [html[data-theme=dark]_&]:border-white/12">
          <UploadedLeasePdfPreview
            dataUrl={previewUrl}
            title={label}
            fileName={attachment.fileName}
            documentFlow
          />
        </div>
        {meta}
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-attr="application-verification-photo">
      <p className="text-xs font-medium text-muted">{label}</p>
      <div className="overflow-hidden rounded-lg border border-border bg-accent/20 [html[data-theme=dark]_&]:border-white/12">
        {isInlineImageAttachment(attachment) && !failed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={label}
            loading="lazy"
            onError={() => setFailed(true)}
            className="mx-auto block max-h-[min(50vh,480px)] w-full object-contain"
          />
        ) : (
          <div className="flex min-h-[12rem] w-full items-center justify-center px-3 text-center text-xs font-medium text-muted">
            {failed ? "Preview unavailable" : "Unsupported file type"}
          </div>
        )}
      </div>
      {meta}
      <a
        href={openUrl}
        target="_blank"
        rel="noreferrer"
        className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        data-attr="application-verification-photo-open"
      >
        Open original
      </a>
    </div>
  );
}

export function ApplicationVerificationPhotos({ row }: { row: DemoApplicantRow }) {
  const app = row.application;
  const front = app?.idPhotoFront ?? null;
  const back = app?.idPhotoBack ?? null;
  const income = Array.isArray(app?.incomeProofPhotos) ? app.incomeProofPhotos : [];
  if (!front && !back && income.length === 0) return null;

  return (
    <section className="mt-4 space-y-4" data-attr="application-verification-photos">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Verification photos</p>
      <div className="space-y-4">
        {front || back ? (
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-muted">ID / driver&apos;s license</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {front ? (
                <PhotoPreview applicationId={row.id} slot="idFront" index={0} label="Front of ID" attachment={front} />
              ) : null}
              {back ? (
                <PhotoPreview applicationId={row.id} slot="idBack" index={0} label="Back of ID" attachment={back} />
              ) : null}
            </div>
          </div>
        ) : null}
        {income.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-muted">Proof of income</p>
            <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
              {income.map((attachment, i) => (
                <PhotoPreview
                  key={attachment.storagePath || i}
                  applicationId={row.id}
                  slot="income"
                  index={i}
                  label={`Document ${i + 1}`}
                  attachment={attachment}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
