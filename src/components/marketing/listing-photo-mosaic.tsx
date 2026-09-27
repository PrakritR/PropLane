"use client";

import Image from "next/image";
import { Camera, Images, Play, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIsClient } from "@/hooks/use-is-client";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import { Button } from "@/components/ui/button";

/**
 * The listing's house photos (PLAN-0914-2124). Desktop is the Airbnb mosaic —
 * one large photo, up to four small — with "Show all N photos" opening every
 * photo in a lightbox; a phone gets a snap-scrolling carousel with a "1 / N"
 * count. With no photos the page does not open on an empty box: it renders
 * `ListingNoPhotoBand`, one short row, and the key facts become the first
 * thing on screen. Photos are only ever the manager's own uploads.
 */
const frame = "relative overflow-hidden bg-accent/25";

function Photo({ src, sizes, priority = false }: { src: string; sizes: string; priority?: boolean }) {
  return <Image src={src} alt="" fill className="object-cover" unoptimized sizes={sizes} priority={priority} />;
}

const pillButtonClassName =
  "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs font-semibold text-foreground shadow-md transition hover:bg-accent/30";

function ShowAllButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} data-attr="listing-photos-show-all" className={pillButtonClassName}>
      <Images className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      Show all {count} photo{count === 1 ? "" : "s"}
    </button>
  );
}

function WatchVideoButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} data-attr="listing-video-watch" className={pillButtonClassName}>
      <Play className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      Watch video
    </button>
  );
}

function PhotoLightbox({ urls, onClose }: { urls: string[]; onClose: () => void }) {
  const isClient = useIsClient();
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  if (!isClient || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[240] flex flex-col bg-black/92" role="dialog" aria-modal aria-label="All photos">
      <div className="flex items-center justify-between px-4 py-3 text-white [html[data-native]_&]:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <p className="text-sm font-semibold">
          {urls.length} photo{urls.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photos"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto grid max-w-4xl gap-3 sm:grid-cols-2">
          {urls.map((src, i) => (
            <div key={`${src.slice(0, 48)}-${i}`} className={`${frame} aspect-[4/3] rounded-xl bg-white/5`}>
              <Photo src={src} sizes="(max-width: 640px) 100vw, 50vw" />
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Full-screen video playback, modeled on `PhotoLightbox`. The `<video>` element
 * only mounts once this component is rendered — i.e. once the viewer has
 * tapped "Watch video" — so a listing page load never fetches video bytes. */
function VideoLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const isClient = useIsClient();
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  if (!isClient || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[240] flex flex-col bg-black/92" role="dialog" aria-modal aria-label="Listing video">
      <div className="flex items-center justify-between px-4 py-3 text-white [html[data-native]_&]:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <p className="text-sm font-semibold">Video</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close video"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <video src={url} controls playsInline autoPlay className="max-h-full w-full" />
      </div>
    </div>,
    document.body,
  );
}

function PhoneCarousel({
  urls,
  topRight,
  onWatchVideo,
}: {
  urls: string[];
  topRight?: ReactNode;
  onWatchVideo?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el || el.clientWidth === 0) return;
    setIndex(Math.min(urls.length - 1, Math.max(0, Math.round(el.scrollLeft / el.clientWidth))));
  }, [urls.length]);
  return (
    <div className={`${frame} aspect-[4/3] w-full`}>
      <div
        ref={trackRef}
        onScroll={onScroll}
        className="flex h-full w-full snap-x snap-mandatory overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label="Listing photos"
      >
        {urls.map((src, i) => (
          <div key={`${src.slice(0, 48)}-${i}`} className="relative h-full w-full shrink-0 snap-center">
            <Photo src={src} sizes="100vw" priority={i === 0} />
          </div>
        ))}
      </div>
      {topRight ? <div className="absolute right-3 top-3 z-10 flex gap-2">{topRight}</div> : null}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2">
        {onWatchVideo ? <WatchVideoButton onClick={onWatchVideo} /> : null}
        <span className="rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-bold text-white tabular-nums">
          {index + 1} / {urls.length}
        </span>
      </div>
    </div>
  );
}

export function ListingPhotoMosaic({
  urls,
  className = "",
  /** Icon buttons drawn over the photo on a phone (back, share, save). */
  phoneTopRight,
  /** The house's own walkthrough video, if the manager uploaded one. */
  videoUrl,
}: {
  urls: string[];
  className?: string;
  phoneTopRight?: ReactNode;
  videoUrl?: string | null;
}) {
  const [allOpen, setAllOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const closeAll = useCallback(() => setAllOpen(false), []);
  const closeVideo = useCallback(() => setVideoOpen(false), []);
  const n = urls.length;
  if (n === 0) return null;
  const small = urls.slice(1, 5);
  const hasVideo = typeof videoUrl === "string" && videoUrl.length > 0;

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="overflow-hidden rounded-2xl md:hidden">
        <PhoneCarousel
          urls={urls}
          topRight={phoneTopRight}
          onWatchVideo={hasVideo ? () => setVideoOpen(true) : undefined}
        />
      </div>
      <div className="relative hidden overflow-hidden rounded-2xl md:block">
        {n === 1 ? (
          <div className={`${frame} aspect-[16/7]`}>
            <Photo src={urls[0]!} sizes="100vw" priority />
          </div>
        ) : n === 2 ? (
          <div className="grid grid-cols-2 gap-2">
            {urls.map((src, i) => (
              <div key={`${src.slice(0, 48)}-${i}`} className={`${frame} aspect-[4/3]`}>
                <Photo src={src} sizes="50vw" priority={i === 0} />
              </div>
            ))}
          </div>
        ) : n <= 4 ? (
          <div className="grid grid-cols-[2fr_1fr] grid-rows-2 gap-2" style={{ height: "clamp(280px, 34vw, 420px)" }}>
            <div className={`${frame} row-span-2`}>
              <Photo src={urls[0]!} sizes="66vw" priority />
            </div>
            {urls.slice(1, 3).map((src, i) => (
              <div key={`${src.slice(0, 48)}-${i}`} className={frame}>
                <Photo src={src} sizes="33vw" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-4 grid-rows-2 gap-2" style={{ height: "clamp(300px, 36vw, 460px)" }}>
            <div className={`${frame} col-span-2 row-span-2`}>
              <Photo src={urls[0]!} sizes="50vw" priority />
            </div>
            {small.map((src, i) => (
              <div key={`${src.slice(0, 48)}-${i}`} className={frame}>
                <Photo src={src} sizes="25vw" />
              </div>
            ))}
          </div>
        )}
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2">
          {hasVideo ? <WatchVideoButton onClick={() => setVideoOpen(true)} /> : null}
          <ShowAllButton count={n} onClick={() => setAllOpen(true)} />
        </div>
      </div>
      {allOpen ? <PhotoLightbox urls={urls} onClose={closeAll} /> : null}
      {videoOpen && hasVideo ? <VideoLightbox url={videoUrl!} onClose={closeVideo} /> : null}
    </div>
  );
}

/**
 * What a home with no photos shows instead of the mosaic: one honest row. The
 * public page says only "Photos coming soon"; the manager's own preview adds
 * the one action that fixes it.
 */
export function ListingNoPhotoBand({
  onAddPhotos,
  className = "",
  /** The house's own walkthrough video, if the manager uploaded one despite having no photos yet. */
  videoUrl,
}: {
  onAddPhotos?: () => void;
  className?: string;
  videoUrl?: string | null;
}) {
  const [videoOpen, setVideoOpen] = useState(false);
  const hasVideo = typeof videoUrl === "string" && videoUrl.length > 0;
  return (
    <div
      className={`flex items-center gap-3.5 rounded-2xl border border-border bg-[var(--pl-surface-muted)] px-4 py-3 ${className}`}
      data-attr="listing-no-photos"
    >
      <div className="relative h-[60px] w-[84px] shrink-0 overflow-hidden rounded-lg border border-border bg-card">
        <NoImagePlaceholder variant="compact" label="" className="!bg-card" />
      </div>
      <p className="min-w-0 flex-1 text-sm font-bold text-foreground">Photos coming soon</p>
      {hasVideo ? <WatchVideoButton onClick={() => setVideoOpen(true)} /> : null}
      {onAddPhotos ? (
        <Button type="button" variant="primary" data-attr="manager-preview-add-photos" onClick={onAddPhotos}>
          <Camera className="h-4 w-4" aria-hidden />
          Add photos
        </Button>
      ) : null}
      {videoOpen && hasVideo ? <VideoLightbox url={videoUrl!} onClose={() => setVideoOpen(false)} /> : null}
    </div>
  );
}
