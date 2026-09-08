/**
 * PRP-430 — Mock B rooms UI on listing-wizard-v2: list rows + Edit drawer,
 * defaults band with Copy to all, house photo strip on Photos step.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editor = readFileSync("src/components/portal/listing-wizard-v2/listing-editor.tsx", "utf8");
const photoStrip = readFileSync("src/components/portal/listing-wizard-v2/listing-photo-strip.tsx", "utf8");

describe("PRP-430 Mock B rooms list", () => {
  it("renders a room list with Edit room affordance, not the spreadsheet RowList for rooms", () => {
    expect(editor).toContain('data-attr="listing-v2-room-list"');
    expect(editor).toContain('data-attr="listing-v2-edit-room"');
    expect(editor).toContain("Defaults for new / following rooms");
    expect(editor).toContain('data-attr="listing-v2-copy-defaults-all"');
    // Rooms no longer use the dashed-inheritance spreadsheet for the main list.
    expect(editor).not.toContain("Most rooms are…");
    expect(editor).not.toContain("Dashed grey means the room is using the house default");
  });

  it("opens a room drawer that can upload photos", () => {
    expect(editor).toContain('dataAttr="listing-v2-room-photos"');
    expect(editor).toContain("Room photos");
    expect(photoStrip).toContain("uploadListingImageFiles");
  });

  it("exposes pets as two explicit chips on Basics", () => {
    expect(editor).toContain('dataAttr="listing-v2-pets-no"');
    expect(editor).toContain('dataAttr="listing-v2-pets-yes"');
  });

  it("surfaces due-at-signing and house photo upload outside More options", () => {
    expect(editor).toContain('dataAttr="listing-v2-house-photos"');
    // Due at signing block sits before the Advanced fees disclosure.
    const dueIdx = editor.indexOf('label="Due at signing"');
    const advancedIdx = editor.indexOf("Advanced fees — waiver code");
    expect(dueIdx).toBeGreaterThan(0);
    expect(advancedIdx).toBeGreaterThan(dueIdx);
  });

  it("merges Claude-2 Home features onto Basics with an Advanced disclosure", () => {
    expect(editor).toContain('dataAttr="listing-v2-by-room"');
    expect(editor).toContain('dataAttr="listing-v2-whole-place"');
    expect(editor).toContain("ListingAddressAutocomplete");
    expect(editor).toContain("Bedrooms you are renting out");
    expect(editor).toContain("The home itself");
    expect(editor).toContain('dataAttr="listing-v2-basics-advanced"');
    expect(editor).toContain("applyListingBedroomSlots");
  });

  it("keeps the six-step Image-2 top chrome labels", () => {
    expect(editor).toContain('{ id: "basics", label: "Basics" }');
    expect(editor).toContain('{ id: "money", label: "Rent & fees" }');
    expect(editor).toContain('{ id: "marketing", label: "Photos" }');
    expect(editor).toContain('{ id: "review", label: "Review" }');
  });
});

describe("PRP-430 stepper chrome", () => {
  it("renders Step N of M in the stepper header", () => {
    const primitives = readFileSync("src/components/portal/listing-wizard-v2/wizard-primitives.tsx", "utf8");
    expect(primitives).toContain('data-attr="listing-v2-stepper"');
    expect(primitives).toContain("Step {current + 1} of {steps.length}");
  });
});
