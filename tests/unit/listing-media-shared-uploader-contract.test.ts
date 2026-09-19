import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const form = readFileSync(
  new URL("../../src/components/portal/pro-add-listing-form.tsx", import.meta.url),
  "utf8",
);

describe("listing wizard media upload boundary", () => {
  it("uses the shared uploader so classified media uses the server capability route", () => {
    expect(form).toMatch(/import \{ uploadListingDataUrl, uploadListingVideoFile \} from "@\/lib\/listing-media-client"/);
    expect(form).toMatch(/return uploadListingDataUrl\(dataUrl\)/);
    expect(form).toMatch(/return uploadListingVideoFile\(file\)/);
    expect(form).not.toMatch(/async function uploadToBucket/);
    expect(form).not.toMatch(/async function uploadViaTus/);
  });
});
