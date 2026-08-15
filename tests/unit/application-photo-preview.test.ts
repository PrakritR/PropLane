import { describe, expect, it } from "vitest";
import {
  applicationPhotoNeedsPreviewConversion,
  applicationPhotoServeBytes,
  contentTypeForApplicationPhotoPath,
} from "@/lib/rental-application/application-photos.server";

describe("application photo inline preview", () => {
  it("detects HEIC/HEIF paths that need conversion", () => {
    expect(applicationPhotoNeedsPreviewConversion("application/foo/idFront.heic", "image/heic")).toBe(true);
    expect(applicationPhotoNeedsPreviewConversion("application/foo/doc.heif", "image/heif")).toBe(true);
    expect(applicationPhotoNeedsPreviewConversion("application/foo/idFront.jpg", "image/jpeg")).toBe(false);
    expect(applicationPhotoNeedsPreviewConversion("application/foo/paystub.pdf", "application/pdf")).toBe(false);
  });

  it("passes through JPEG bytes unchanged when preview is requested", async () => {
    const bytes = Buffer.from("fake-jpeg-bytes");
    const served = await applicationPhotoServeBytes(bytes, "application/x/idFront.jpg", { preview: true });
    expect(served.body).toBe(bytes);
    expect(served.contentType).toBe(contentTypeForApplicationPhotoPath("application/x/idFront.jpg"));
  });

  it("falls back to original bytes when HEIC conversion fails", async () => {
    const bytes = Buffer.from("not-a-real-heic");
    const served = await applicationPhotoServeBytes(bytes, "application/x/idFront.heic", { preview: true });
    expect(served.body).toEqual(bytes);
    expect(served.contentType).toBe("image/heic");
  });
});
