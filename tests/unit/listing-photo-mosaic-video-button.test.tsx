// @vitest-environment jsdom
//
// The house video a manager uploads never reached the public listing page:
// `publicListingProjection` allowlists room/bathroom/shared-space videos but
// not the house one, and the photo block had no button to open it. This
// covers the client half of that fix — `ListingPhotoMosaic` (photos present)
// and `ListingNoPhotoBand` (no photos yet) both render a "Watch video" button
// only when a video URL is actually passed in, the clip is not mounted until
// tapped (no preload of the video bytes), and it opens full screen with a
// working close control.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListingPhotoMosaic, ListingNoPhotoBand } from "@/components/marketing/listing-photo-mosaic";

afterEach(() => cleanup());

const PHOTO_URLS = ["https://cdn.proplane.test/a.jpg", "https://cdn.proplane.test/b.jpg"];
const VIDEO_URL = "https://cdn.proplane.test/house-walkthrough.mp4";

describe("ListingPhotoMosaic — Watch video button", () => {
  it("renders no Watch video button and no <video> element when there is no video", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} />);
    expect(screen.getAllByText(/Show all \d photos/)[0]).toBeTruthy();
    expect(screen.queryByText("Watch video")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
  });

  it("renders the Watch video button when a video is present, and does not mount <video> until tapped", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} videoUrl={VIDEO_URL} />);
    const buttons = screen.getAllByText("Watch video");
    expect(buttons.length).toBeGreaterThan(0);
    // No preload of the video bytes: the <video> element only exists after tap.
    expect(document.querySelector("video")).toBeNull();

    fireEvent.click(buttons[0]!);

    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe(VIDEO_URL);
    expect(screen.getByRole("dialog", { name: "Listing video" })).toBeTruthy();
  });

  it("closes on Escape", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} videoUrl={VIDEO_URL} />);
    fireEvent.click(screen.getAllByText("Watch video")[0]!);
    expect(document.querySelector("video")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(document.querySelector("video")).toBeNull();
  });

  it("closes on the dialog's close control", () => {
    render(<ListingPhotoMosaic urls={PHOTO_URLS} videoUrl={VIDEO_URL} />);
    fireEvent.click(screen.getAllByText("Watch video")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Close video" }));
    expect(document.querySelector("video")).toBeNull();
  });

  it("returns null with no photos regardless of video", () => {
    const { container } = render(<ListingPhotoMosaic urls={[]} videoUrl={VIDEO_URL} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ListingNoPhotoBand — Watch video button", () => {
  it("renders no Watch video button when there is no video", () => {
    render(<ListingNoPhotoBand />);
    expect(screen.getByText("Photos coming soon")).toBeTruthy();
    expect(screen.queryByText("Watch video")).toBeNull();
  });

  it("renders the Watch video button and opens the clip full screen when a video is present", () => {
    render(<ListingNoPhotoBand videoUrl={VIDEO_URL} />);
    const button = screen.getByText("Watch video");
    expect(document.querySelector("video")).toBeNull();

    fireEvent.click(button);

    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe(VIDEO_URL);
  });
});
