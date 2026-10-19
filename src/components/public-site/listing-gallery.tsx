"use client";

import Image from "next/image";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIsClient } from "@/hooks/use-is-client";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import type { ListingRichContent } from "@/data/listing-rich-content";
import "@/components/public-site/listing-gallery.css";

/**
 * The listing's photos, first thing on the page. A phone gets a full-bleed swipe strip (CSS scroll-snap, no
 * carousel library) with a square "1 / N" plate; a desktop gets a lead photo with up to four beside it and an
 * "All photos" button. Either opens the same full-screen viewer. Photos are only ever the manager's own uploads:
 * with none, the slot holds `NoImagePlaceholder`, never a stock image.
 */

export type ListingGalleryPhoto = { url: string; caption: string };

/** Every real photo the listing carries: the house first, then each room, bathroom and shared space. Captions are the space name. */
export function collectListingPhotos(rich: ListingRichContent, houseCaption: string): ListingGalleryPhoto[] {
  const seen = new Set<string>();
  const out: ListingGalleryPhoto[] = [];
  const add = (urls: readonly (string | null | undefined)[] | undefined, caption: string) => {
    for (const raw of urls ?? []) {
      const url = typeof raw === "string" ? raw.trim() : "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, caption });
    }
  };
  add(rich.heroHousePhotoUrls, houseCaption);
  for (const floor of rich.floorPlans) for (const room of floor.rooms) add(room.modal.photoUrls, room.name);
  for (const bath of rich.bathrooms) add(bath.modal.photoUrls, bath.name);
  for (const space of rich.sharedSpaces) add(space.modal.photoUrls, space.name);
  return out;
}

function Frame({ photo, sizes, priority = false }: { photo: ListingGalleryPhoto; sizes: string; priority?: boolean }) {
  return <Image src={photo.url} alt={photo.caption} fill unoptimized sizes={sizes} priority={priority} className="ps-gal-img" />;
}

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function Viewer({ photos, start, onClose }: { photos: ListingGalleryPhoto[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchX = useRef<number | null>(null);
  const count = photos.length;
  const go = useCallback((delta: number) => setIndex((i) => (i + delta + count) % count), [count]);

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      returnTo?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Tab") {
        const nodes = rootRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!nodes || nodes.length === 0) return;
        const first = nodes[0]!;
        const last = nodes[nodes.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  const photo = photos[index]!;
  return (
    <div
      ref={rootRef}
      className="ps ps-view"
      role="dialog"
      aria-modal="true"
      aria-label="Photos"
      data-attr="listing-photo-viewer"
    >
      <div className="ps-view-top">
        <p className="ps-view-count" aria-live="polite">
          {index + 1} / {count}
        </p>
        <button ref={closeRef} type="button" className="ps-icon-btn" aria-label="Close" title="Close" onClick={onClose}>
          <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div
        className="ps-view-stage"
        onTouchStart={(e) => {
          touchX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          const from = touchX.current;
          touchX.current = null;
          const to = e.changedTouches[0]?.clientX;
          if (from === null || to === undefined) return;
          if (Math.abs(to - from) > 48) go(to < from ? 1 : -1);
        }}
      >
        <Image
          key={photo.url}
          src={photo.url}
          alt={photo.caption}
          fill
          unoptimized
          sizes="100vw"
          priority
          className="ps-view-img"
        />
      </div>
      <div className="ps-view-bot">
        <p className="ps-view-cap">{photo.caption}</p>
        {count > 1 ? (
          <div className="ps-view-nav">
            <button type="button" className="ps-icon-btn" aria-label="Previous photo" title="Previous photo" onClick={() => go(-1)}>
              <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </button>
            <button type="button" className="ps-icon-btn" aria-label="Next photo" title="Next photo" onClick={() => go(1)}>
              <ChevronRight className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ListingGallery({
  photos,
  empty,
  videoUrl = null,
  className = "",
}: {
  photos: ListingGalleryPhoto[];
  /** What fills the slot when there are no photos (default: the honest placeholder). */
  empty?: ReactNode;
  videoUrl?: string | null;
  className?: string;
}) {
  const isClient = useIsClient();
  const [viewer, setViewer] = useState<number | null>(null);
  const [slide, setSlide] = useState(0);
  const count = photos.length;
  const closeViewer = useCallback(() => setViewer(null), []);

  if (count === 0) {
    return (
      <div className={`ps-gal ${className}`} data-attr="listing-gallery" data-count="0">
        {empty ?? (
          <div className="ps-gal-empty">
            <NoImagePlaceholder variant="compact" />
          </div>
        )}
        {videoUrl ? (
          <p className="ps-gal-video">
            <a href={videoUrl} target="_blank" rel="noopener noreferrer" className="ps-link" data-attr="listing-video-watch">
              Watch video
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  const grid = photos.slice(0, 5);
  return (
    <div className={`ps-gal ${className}`} data-attr="listing-gallery" data-count={count}>
      {/* Phone: swipe strip. */}
      <div className="ps-gal-strip-wrap">
        <div
          className="ps-gal-strip"
          role="region"
          aria-label="Listing photos"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            const next = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
            setSlide((prev) => (prev === next ? prev : next));
          }}
        >
          {photos.map((photo, i) => (
            <button
              key={photo.url}
              type="button"
              className="ps-gal-slide"
              onClick={() => setViewer(i)}
              aria-label={`Open photo ${i + 1} of ${count}: ${photo.caption}`}
              data-attr="listing-photo-open"
            >
              <Frame photo={photo} sizes="100vw" priority={i === 0} />
            </button>
          ))}
        </div>
        <p className="ps-gal-plate" aria-hidden>
          {Math.min(slide, count - 1) + 1} / {count}
        </p>
      </div>

      {/* Desktop: lead photo plus up to four. */}
      <div className="ps-gal-grid" data-n={Math.min(count, 5)}>
        {grid.map((photo, i) => (
          <button
            key={photo.url}
            type="button"
            className={`ps-gal-cell ${i === 0 ? "ps-gal-lead" : ""}`}
            onClick={() => setViewer(i)}
            aria-label={`Open photo ${i + 1} of ${count}: ${photo.caption}`}
            data-attr="listing-photo-open"
          >
            <Frame photo={photo} sizes={i === 0 ? "(min-width: 1024px) 60vw, 100vw" : "20vw"} />
          </button>
        ))}
        {count > 1 ? (
          <button
            type="button"
            className="ps-btn ps-btn-line ps-gal-all"
            onClick={() => setViewer(0)}
            data-attr="listing-photos-show-all"
          >
            All photos · {count}
          </button>
        ) : null}
      </div>

      {videoUrl ? (
        <p className="ps-gal-video">
          <a href={videoUrl} target="_blank" rel="noopener noreferrer" className="ps-link" data-attr="listing-video-watch">
            Watch video
          </a>
        </p>
      ) : null}

      {isClient && viewer !== null ? createPortal(<Viewer photos={photos} start={viewer} onClose={closeViewer} />, document.body) : null}
    </div>
  );
}
