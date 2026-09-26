// @vitest-environment jsdom
//
// Both rejections below must happen before any network call — a phone
// clip that is too large or the wrong kind should never start an upload.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LISTING_VIDEO_BYTES, uploadListingVideoFile } from "@/lib/listing-media-client";

function fileOfSize(bytes: number, name = "clip.mp4", type = "video/mp4"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("uploadListingVideoFile guards", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("rejects a file over the 50 MB ceiling without making a network call", async () => {
    global.fetch = vi.fn(() => {
      throw new Error("must not call fetch");
    }) as unknown as typeof fetch;

    const file = fileOfSize(MAX_LISTING_VIDEO_BYTES + 1);
    await expect(uploadListingVideoFile(file)).rejects.toThrow("Video too large (max 50 MB).");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a non-video file without making a network call", async () => {
    global.fetch = vi.fn(() => {
      throw new Error("must not call fetch");
    }) as unknown as typeof fetch;

    const file = fileOfSize(1024, "notes.txt", "text/plain");
    await expect(uploadListingVideoFile(file)).rejects.toThrow("Please choose a video file.");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("accepts a video with no MIME type by its extension, still under the ceiling, still rejects on size", async () => {
    global.fetch = vi.fn(() => {
      throw new Error("must not call fetch");
    }) as unknown as typeof fetch;

    // Empty type, known extension, but oversized — the size guard must still
    // fire before any network call, proving the extension fallback did not
    // accidentally skip the ceiling check.
    const file = fileOfSize(MAX_LISTING_VIDEO_BYTES + 1, "clip.mov", "");
    await expect(uploadListingVideoFile(file)).rejects.toThrow("Video too large (max 50 MB).");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
