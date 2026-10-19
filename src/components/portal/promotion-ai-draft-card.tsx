"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { FLYER_IMAGE_LIMIT } from "@/lib/promotion-flyer";

export function PromotionAiBetaBadge() {
  return (
    <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
      Beta
    </span>
  );
}

export function PromotionAiDraftPhotoPicker({
  images,
  imageLimit = FLYER_IMAGE_LIMIT,
  readingPhotos,
  onPhotoFiles,
  onRemovePhoto,
}: {
  images: string[];
  imageLimit?: number;
  readingPhotos?: boolean;
  onPhotoFiles: (files: FileList | null) => void;
  onRemovePhoto: (index: number) => void;
}) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted">
        Property photos <span className="font-normal">(up to {imageLimit})</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {images.map((src, i) => (
          <div key={i} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- small local data-URL thumbnail */}
            <img
              src={src}
              alt={`Uploaded property photo ${i + 1}`}
              className="h-16 w-20 rounded-lg border border-border object-cover"
            />
            <button
              type="button"
              aria-label={`Remove photo ${i + 1}`}
              onClick={() => onRemovePhoto(i)}
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-[11px] font-bold leading-none text-background shadow"
              data-attr="promotion-photo-remove"
            >
              ×
            </button>
          </div>
        ))}
        {images.length < imageLimit ? (
          <label
            className="flex h-16 w-20 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-border text-muted transition-colors hover:border-primary/40 hover:text-primary"
            data-attr="promotion-photo-add"
          >
            <span className="text-lg leading-none">+</span>
            <span className="text-[10px] font-semibold">{readingPhotos ? "Adding…" : "Add photo"}</span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              disabled={readingPhotos}
              onChange={(e) => {
                onPhotoFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        ) : null}
      </div>
    </div>
  );
}

export function PromotionAiDraftCard({
  description,
  prompt,
  onPromptChange,
  promptPlaceholder = "Describe highlights, tone, or anything to emphasize…",
  promptId,
  onDraft,
  drafting,
  draftLabel = "Write for me",
  draftingLabel = "Drafting…",
  draftDataAttr = "promotion-ai-draft",
  images,
  imageLimit,
  readingPhotos,
  onPhotoFiles,
  onRemovePhoto,
  children,
}: {
  description?: string;
  prompt?: string;
  onPromptChange?: (value: string) => void;
  promptPlaceholder?: string;
  promptId?: string;
  onDraft: () => void;
  drafting?: boolean;
  draftLabel?: string;
  draftingLabel?: string;
  draftDataAttr?: string;
  images?: string[];
  imageLimit?: number;
  readingPhotos?: boolean;
  onPhotoFiles?: (files: FileList | null) => void;
  onRemovePhoto?: (index: number) => void;
  children?: ReactNode;
}) {
  const showPrompt = onPromptChange != null;
  const showPhotos = images != null && onPhotoFiles != null && onRemovePhoto != null;

  const draftButton = (
    <Button
      type="button"
      disabled={drafting}
      data-attr={draftDataAttr}
      onClick={onDraft}
      className={showPhotos ? "shrink-0 self-end" : undefined}
    >
      {drafting ? draftingLabel : draftLabel}
    </Button>
  );

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-foreground">AI draft</span>
        <PromotionAiBetaBadge />
      </div>
      {description ? <p className="mt-1.5 text-xs leading-relaxed text-muted">{description}</p> : null}
      {showPrompt ? (
        <div className={description ? "mt-3" : "mt-2"}>
          <Textarea
            id={promptId}
            rows={3}
            value={prompt ?? ""}
            onChange={(e) => onPromptChange(e.target.value)}
            placeholder={promptPlaceholder}
          />
        </div>
      ) : null}
      {showPhotos ? (
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <PromotionAiDraftPhotoPicker
              images={images}
              imageLimit={imageLimit}
              readingPhotos={readingPhotos}
              onPhotoFiles={onPhotoFiles}
              onRemovePhoto={onRemovePhoto}
            />
          </div>
          {draftButton}
        </div>
      ) : null}
      {children}
      {showPhotos ? null : <div className="mt-3">{draftButton}</div>}
    </div>
  );
}
