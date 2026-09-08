"use client";

/**
 * Compact photo gallery for listing-wizard-v2 (house + room drawers).
 * Uploads through the same client path as production (`uploadListingImageFiles`).
 */

import { useRef, useState, type ReactNode } from "react";
import { uploadListingImageFiles } from "@/lib/listing-media-client";
import { cn } from "@/lib/utils";

const DEFAULT_MAX = 8;

export function ListingPhotoStrip({
  urls,
  onChange,
  max = DEFAULT_MAX,
  label = "Photos",
  addLabel = "+ Add photos",
  className,
  dataAttr,
}: {
  urls: string[];
  onChange: (next: string[]) => void;
  max?: number;
  label?: string;
  addLabel?: string;
  className?: string;
  dataAttr?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const remaining = max - urls.length;
    if (remaining <= 0) {
      setError(`You can add up to ${max} photos.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadListingImageFiles(Array.from(files).slice(0, remaining));
      onChange([...urls, ...uploaded]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("mb-4", className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-bold text-foreground">{label}</span>
        <span className="text-[11px] font-semibold text-muted">
          {urls.length}/{max}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {urls.map((url, i) => (
          <div key={`${url.slice(0, 48)}-${i}`} className="relative h-20 w-20 overflow-hidden rounded-lg border border-border bg-muted/30">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              aria-label={`Remove photo ${i + 1}`}
              className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/65 text-[11px] font-bold text-white"
              onClick={() => onChange(urls.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        {urls.length < max ? (
          <MediaPickButton
            busy={busy}
            dataAttr={dataAttr}
            onPick={() => inputRef.current?.click()}
          >
            {busy ? "Uploading…" : addLabel}
          </MediaPickButton>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none fixed -left-[9999px] top-0 h-px w-px opacity-0"
        onChange={(e) => {
          void onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {error ? <p className="mt-1.5 text-[12px] font-semibold text-red-600">{error}</p> : null}
    </div>
  );
}

function MediaPickButton({
  children,
  busy,
  onPick,
  dataAttr,
}: {
  children: ReactNode;
  busy?: boolean;
  onPick: () => void;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      data-attr={dataAttr}
      onClick={onPick}
      className="flex h-20 min-w-[5rem] flex-col items-center justify-center rounded-lg border-2 border-dashed border-primary px-3 text-[11.5px] font-bold text-primary disabled:opacity-60"
    >
      {children}
    </button>
  );
}
