"use client";

import { useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { uploadListingImageFiles, uploadListingVideoFile } from "@/lib/listing-media-client";

const MAX_MOVE_IN_PHOTOS = 8;
const MEDIA_PICK_BTN_CLASS =
  "inline-flex cursor-pointer items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:border-primary/35 hover:bg-primary/[0.06] disabled:cursor-not-allowed disabled:opacity-60";

function MediaPickTrigger({
  accept,
  multiple,
  disabled,
  onFiles,
  children,
}: {
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: FileList | null) => void;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none fixed -left-[9999px] top-0 h-px w-px opacity-0"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        className={MEDIA_PICK_BTN_CLASS}
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </button>
    </>
  );
}

export function MoveInMediaFields({
  photoDataUrls,
  videoDataUrl,
  disabled,
  onPhotosChange,
  onVideoChange,
  onError,
}: {
  photoDataUrls: string[];
  videoDataUrl: string | null;
  disabled: boolean;
  onPhotosChange: (urls: string[]) => void;
  onVideoChange: (url: string | null) => void;
  onError: (message: string) => void;
}) {
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);

  const onPickPhotos = async (files: FileList | null) => {
    if (!files?.length || disabled) return;
    const remaining = MAX_MOVE_IN_PHOTOS - photoDataUrls.length;
    if (remaining <= 0) {
      onError(`You can add up to ${MAX_MOVE_IN_PHOTOS} photos.`);
      return;
    }
    const slice = Array.from(files).slice(0, remaining);
    setUploadingPhotos(true);
    try {
      const uploaded = await uploadListingImageFiles(slice);
      onPhotosChange([...photoDataUrls, ...uploaded]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Photo upload failed.");
    } finally {
      setUploadingPhotos(false);
    }
  };

  const onPickVideo = async (file: File | null) => {
    if (!file || disabled) return;
    setUploadingVideo(true);
    try {
      const uploaded = await uploadListingVideoFile(file);
      onVideoChange(uploaded);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Video upload failed.");
    } finally {
      setUploadingVideo(false);
    }
  };

  return (
    <div className="mt-6 grid grid-cols-1 gap-5 border-t border-border/60 pt-5 sm:grid-cols-2">
      <div>
        <p className="text-xs font-semibold text-muted">
          Move-in photos
          <span className="ml-1.5 font-normal">— residents can view these on House details</span>
        </p>
        {photoDataUrls.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {photoDataUrls.map((url, index) => (
              <div key={`${url}-${index}`} className="relative h-20 w-20 overflow-hidden rounded-lg border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="h-full w-full object-cover" />
                {!disabled ? (
                  <button
                    type="button"
                    aria-label="Remove photo"
                    className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5 text-foreground shadow"
                    onClick={() => onPhotosChange(photoDataUrls.filter((_, i) => i !== index))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {!disabled && photoDataUrls.length < MAX_MOVE_IN_PHOTOS ? (
          <div className="mt-3">
            <MediaPickTrigger accept="image/*" multiple disabled={uploadingPhotos} onFiles={(files) => { void onPickPhotos(files); }}>
              {uploadingPhotos ? "Uploading…" : "Add photos"}
            </MediaPickTrigger>
          </div>
        ) : null}
      </div>

      <div>
        <p className="text-xs font-semibold text-muted">
          Move-in video
          <span className="ml-1.5 font-normal">— optional walkthrough residents can watch</span>
        </p>
        {videoDataUrl ? (
          <div className="mt-3 space-y-2">
            <video src={videoDataUrl} controls playsInline className="max-h-64 w-full rounded-lg border border-border bg-black" />
            {!disabled ? (
              <button
                type="button"
                className="text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => onVideoChange(null)}
              >
                Remove video
              </button>
            ) : null}
          </div>
        ) : null}
        {!disabled && !videoDataUrl ? (
          <div className="mt-3">
            <MediaPickTrigger accept="video/*" disabled={uploadingVideo} onFiles={(files) => { void onPickVideo(files?.[0] ?? null); }}>
              {uploadingVideo ? "Uploading…" : "Add video"}
            </MediaPickTrigger>
          </div>
        ) : !disabled && videoDataUrl ? (
          <div className="mt-3">
            <MediaPickTrigger accept="video/*" disabled={uploadingVideo} onFiles={(files) => { void onPickVideo(files?.[0] ?? null); }}>
              {uploadingVideo ? "Uploading…" : "Replace video"}
            </MediaPickTrigger>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ResidentMoveInMediaGallery({
  photoDataUrls,
  videoDataUrl,
}: {
  photoDataUrls: string[];
  videoDataUrl: string | null;
}) {
  if (photoDataUrls.length === 0 && !videoDataUrl) return null;

  return (
    <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
      {photoDataUrls.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Photos</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {photoDataUrls.map((url, index) => (
              <a
                key={`${url}-${index}`}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="block overflow-hidden rounded-lg border border-border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="aspect-[4/3] w-full object-cover" />
              </a>
            ))}
          </div>
        </div>
      ) : null}
      {videoDataUrl ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Video walkthrough</p>
          <video src={videoDataUrl} controls playsInline className="mt-2 max-h-80 w-full rounded-lg border border-border bg-black" />
        </div>
      ) : null}
    </div>
  );
}
