// @vitest-environment jsdom
//
// M017 — blur-up image + lightbox entrance polish + snap carousel a11y on
// the listing photo mosaic (the public listing page AND manager property
// Preview both render through ListingDetailSections -> this component).
// Photos are never fabricated: only the manager's own real photo bytes ever
// render, blurred while their own network load is in flight.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ListingPhotoMosaic } from "@/components/marketing/listing-photo-mosaic";

afterEach(cleanup);

const PHOTO_URLS = [
  "https://cdn.proplane.test/1.jpg",
  "https://cdn.proplane.test/2.jpg",
  "https://cdn.proplane.test/3.jpg",
];

describe("ListingPhotoMosaic — M017", () => {
  it("blurs up: starts not-loaded, then flips to is-loaded on the real image's own onLoad", async () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} />);
    const img = document.querySelector('img[src="https://cdn.proplane.test/1.jpg"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.classList.contains("is-loaded")).toBe(false);
    fireEvent.load(img);
    // next/image's own onLoad wraps ours behind an `img.decode()` microtask.
    await waitFor(() => expect(img.classList.contains("is-loaded")).toBe(true));
  });

  it("never fabricates a placeholder image — the src is always the manager's own real photo", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} />);
    const imgs = Array.from(document.querySelectorAll("img")).map((el) => el.getAttribute("src"));
    for (const src of imgs) {
      expect(PHOTO_URLS).toContain(src);
    }
  });

  it("picks up an already-cached image (complete on mount) without waiting for a load event that will never fire again", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
    Object.defineProperty(HTMLImageElement.prototype, "complete", { configurable: true, get: () => true });
    try {
      render(<ListingPhotoMosaic urls={PHOTO_URLS} />);
      const img = document.querySelector('img[src="https://cdn.proplane.test/1.jpg"]') as HTMLImageElement;
      expect(img.classList.contains("is-loaded")).toBe(true);
    } finally {
      if (originalDescriptor) Object.defineProperty(HTMLImageElement.prototype, "complete", originalDescriptor);
    }
  });

  it("gives the phone carousel real carousel a11y roles", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} />);
    expect(document.querySelector('[aria-roledescription="carousel"]')).not.toBeNull();
    const slides = document.querySelectorAll('[aria-roledescription="slide"]');
    expect(slides).toHaveLength(3);
    expect(slides[0]).toHaveAttribute("aria-label", "Photo 1 of 3");
  });

  it("advances the carousel on Arrow-Right and mirrors the position for screen readers", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} />);
    const track = document.querySelector('[aria-roledescription="carousel"]') as HTMLElement;
    track.scrollTo = vi.fn();
    Object.defineProperty(track, "clientWidth", { value: 400, configurable: true });
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(track.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 400 }));
  });

  it("never scrolls past the last photo on Arrow-Right from the last slide", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} />);
    const track = document.querySelector('[aria-roledescription="carousel"]') as HTMLElement;
    Object.defineProperty(track, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(track, "scrollLeft", { value: 800, configurable: true }); // already on the 3rd (last) slide
    fireEvent.scroll(track); // syncs the carousel's own index state, same as a real drag would
    track.scrollTo = vi.fn();
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(track.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 800 }));
  });
});
