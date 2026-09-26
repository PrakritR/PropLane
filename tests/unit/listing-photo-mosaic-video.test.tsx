// @vitest-environment jsdom
//
// The house-level walkthrough video (`houseVideoDataUrl`) gets a "Watch video"
// pill next to "Show all N photos" on desktop, and bottom-right on the phone
// carousel and the no-photos band. The <video> element must not mount until
// the viewer taps the pill — egress budget forbids fetching video bytes on a
// plain page view.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListingNoPhotoBand, ListingPhotoMosaic } from "@/components/marketing/listing-photo-mosaic";

afterEach(cleanup);

const PHOTO_URLS = ["https://cdn.proplane.test/1.jpg", "https://cdn.proplane.test/2.jpg"];
const VIDEO_URL = "https://cdn.proplane.test/house-walkthrough.mp4";

describe("ListingPhotoMosaic video", () => {
  it("shows no Watch video pill and mounts no <video> when videoUrl is absent", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} />);
    expect(screen.queryByText("Watch video")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
  });

  it("shows the Watch video pill and mounts a <video> with that src only after clicking", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} videoUrl={VIDEO_URL} />);
    const watchButtons = screen.getAllByText("Watch video");
    expect(watchButtons.length).toBeGreaterThan(0);
    expect(document.querySelector("video")).toBeNull();

    fireEvent.click(watchButtons[0]!);

    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe(VIDEO_URL);
  });

  it("closes the video lightbox and unmounts the <video> on Escape", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} videoUrl={VIDEO_URL} />);
    fireEvent.click(screen.getAllByText("Watch video")[0]!);
    expect(document.querySelector("video")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector("video")).toBeNull();
  });
});

describe("ListingNoPhotoBand video", () => {
  it("has no Watch video pill without a videoUrl", () => {
    render(<ListingNoPhotoBand />);
    expect(screen.queryByText("Watch video")).toBeNull();
  });

  it("shows Watch video and mounts a <video> with that src once clicked", () => {
    render(<ListingNoPhotoBand videoUrl={VIDEO_URL} />);
    expect(document.querySelector("video")).toBeNull();

    fireEvent.click(screen.getByText("Watch video"));

    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe(VIDEO_URL);
  });
});
