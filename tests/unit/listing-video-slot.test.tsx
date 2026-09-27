// @vitest-environment jsdom
//
// VideoSlot used to read a picked clip with FileReader.readAsDataURL and hold
// the base64 data URL on the submission — a 40-170MB phone clip made the iOS
// web view fail in total silence (no error, no spinner, the tile stayed on
// "+"). It now uploads on pick, the same way PhotoStrip already does for
// photos, and never stores a `data:` URL.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

const uploadListingVideoFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/listing-media-client", () => ({
  uploadListingImageFiles: vi.fn(),
  uploadListingDataUrl: vi.fn(),
  uploadListingVideoFile,
  MAX_LISTING_VIDEO_BYTES: 50 * 1024 * 1024,
}));

import { VideoSlot } from "@/components/portal/listing-wizard-v2/listing-editor";

afterEach(() => {
  cleanup();
  uploadListingVideoFile.mockReset();
});

function pickVideo(input: HTMLElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

describe("VideoSlot", () => {
  it("uploads the picked file and calls onChange with the returned URL", async () => {
    uploadListingVideoFile.mockResolvedValue("https://cdn.test/videos/house.mp4");
    const onChange = vi.fn();
    render(<VideoSlot label="house" url={null} onChange={onChange} />);

    const input = screen.getByLabelText("Add house video");
    const file = new File(["bytes"], "clip.mov", { type: "video/quicktime" });
    pickVideo(input, file);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("https://cdn.test/videos/house.mp4"));
    expect(uploadListingVideoFile).toHaveBeenCalledTimes(1);
    expect(uploadListingVideoFile.mock.calls[0]![0]).toBe(file);
    expect(typeof uploadListingVideoFile.mock.calls[0]![1]?.onProgress).toBe("function");

    // Never a data: URL.
    expect(onChange).not.toHaveBeenCalledWith(expect.stringMatching(/^data:/));
  });

  it("shows the uploader's error under the tile and never calls onChange with a data URL when the upload rejects", async () => {
    uploadListingVideoFile.mockRejectedValue(new Error("Video too large (max 50 MB)."));
    const onChange = vi.fn();
    render(<VideoSlot label="house" url={null} onChange={onChange} />);

    const input = screen.getByLabelText("Add house video");
    const file = new File(["bytes"], "clip.mov", { type: "video/quicktime" });
    pickVideo(input, file);

    await waitFor(() => expect(screen.getByText("Video too large (max 50 MB).")).toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
    // The tile is restored to "+" rather than left on a permanent busy state.
    expect(screen.getByLabelText("Add house video")).not.toBeDisabled();
  });

  it("shows upload progress on the tile while busy", async () => {
    let resolveUpload: ((url: string) => void) | undefined;
    uploadListingVideoFile.mockImplementation(
      (_file: File, opts?: { onProgress?: (fraction: number) => void }) =>
        new Promise<string>((resolve) => {
          resolveUpload = resolve;
          opts?.onProgress?.(0.42);
        }),
    );
    const onChange = vi.fn();
    render(<VideoSlot label="house" url={null} onChange={onChange} />);

    const input = screen.getByLabelText("Add house video");
    const file = new File(["bytes"], "clip.mp4", { type: "video/mp4" });
    pickVideo(input, file);

    await waitFor(() => expect(screen.getByText("42%")).toBeInTheDocument());
    expect(screen.getByLabelText("Add house video")).toBeDisabled();

    resolveUpload?.("https://cdn.test/videos/house.mp4");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("https://cdn.test/videos/house.mp4"));
  });
});
