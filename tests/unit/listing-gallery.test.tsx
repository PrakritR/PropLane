// @vitest-environment jsdom
/**
 * The public listing's photos: every real photo in one gallery (house first, then each space, captioned with its
 * name), a placeholder and never a stock image when there are none, and a viewer that closes on Escape, steps with
 * the arrow keys and hands focus back.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListingGallery, collectListingPhotos } from "@/components/public-site/listing-gallery";
import type { ListingRichContent } from "@/data/listing-rich-content";

afterEach(cleanup);

const rich = {
  heroHousePhotoUrls: ["https://x.test/house-1.jpg", "https://x.test/house-2.jpg"],
  floorPlans: [
    {
      rooms: [
        { id: "r1", name: "Room 1", modal: { photoUrls: ["https://x.test/r1.jpg", "https://x.test/house-1.jpg"] } },
        { id: "r2", name: "Room 2", modal: {} },
      ],
    },
  ],
  bathrooms: [{ id: "b1", name: "Main bath", modal: { photoUrls: ["https://x.test/b1.jpg"] } }],
  sharedSpaces: [{ id: "s1", name: "Kitchen", modal: { photoUrls: ["https://x.test/k.jpg", "  "] } }],
} as unknown as ListingRichContent;

describe("collectListingPhotos", () => {
  it("lists the house first, then rooms, bathrooms and shared spaces, captioned by space, without repeats", () => {
    expect(collectListingPhotos(rich, "Alder House")).toEqual([
      { url: "https://x.test/house-1.jpg", caption: "Alder House" },
      { url: "https://x.test/house-2.jpg", caption: "Alder House" },
      { url: "https://x.test/r1.jpg", caption: "Room 1" },
      { url: "https://x.test/b1.jpg", caption: "Main bath" },
      { url: "https://x.test/k.jpg", caption: "Kitchen" },
    ]);
  });
});

describe("ListingGallery", () => {
  it("holds the honest placeholder, not a photo, when there are none", () => {
    const { container } = render(<ListingGallery photos={[]} />);
    expect(screen.getByRole("img", { name: "No photos yet" })).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-attr="listing-photos-show-all"]')).toBeNull();
  });

  it("offers All photos with the count and opens a viewer that steps, wraps and closes on Escape", () => {
    const photos = collectListingPhotos(rich, "Alder House");
    const { container } = render(<ListingGallery photos={photos} />);
    const all = container.querySelector('[data-attr="listing-photos-show-all"]') as HTMLButtonElement;
    expect(all.textContent).toBe("All photos · 5");
    all.focus();
    fireEvent.click(all);
    const viewer = document.querySelector('[data-attr="listing-photo-viewer"]') as HTMLElement;
    expect(viewer.getAttribute("role")).toBe("dialog");
    expect(viewer.textContent).toContain("1 / 5");
    expect(viewer.textContent).toContain("Alder House");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(viewer.textContent).toContain("3 / 5");
    expect(viewer.textContent).toContain("Room 1");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(viewer.textContent).toContain("5 / 5");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector('[data-attr="listing-photo-viewer"]')).toBeNull();
    expect(document.activeElement).toBe(all);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("a single photo is one image with no All photos button, and tapping it still opens the viewer", () => {
    const { container } = render(<ListingGallery photos={[{ url: "https://x.test/a.jpg", caption: "Alder House" }]} />);
    expect(container.querySelector('[data-attr="listing-photos-show-all"]')).toBeNull();
    fireEvent.click(container.querySelector('.ps-gal-grid [data-attr="listing-photo-open"]')!);
    expect(document.querySelector('[data-attr="listing-photo-viewer"]')!.textContent).toContain("1 / 1");
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
  });
});
