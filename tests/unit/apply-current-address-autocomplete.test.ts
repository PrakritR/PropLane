/**
 * AXI-168 — "when i am putting in my address and city i can put a fake address
 * and it still lets me click next, it should verify that the address I am
 * putting is a real address."
 *
 * The applicant's current address was three free-text boxes with nothing
 * connecting them, so a made-up street sailed through and city / state / ZIP
 * could contradict it. It now uses the same address search the listing wizard
 * already had.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const steps = readFileSync(
  path.join(process.cwd(), "src/components/marketing/rental-wizard-steps.tsx"),
  "utf8",
);
const block = steps.split("<ListingAddressAutocomplete")[1]?.split("/>")[0] ?? "";

describe("applicant current address", () => {
  it("reuses the listing wizard's address search rather than a new one", () => {
    expect(steps).toContain(
      'import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete"',
    );
  });

  it("is bound to the applicant's own street field", () => {
    expect(block).toContain("form.currentStreet");
    expect(block).toContain("patch({ currentStreet })");
  });

  it("fills city, state and ZIP from the chosen address", () => {
    // The point of the change: the four fields can no longer disagree, because
    // three of them come from the geocoder rather than free text.
    expect(block).toContain("currentCity: suggestion.city");
    expect(block).toContain("currentState: suggestion.state");
    expect(block).toContain("currentZip: suggestion.zip");
  });

  it("only overwrites a field the suggestion actually carries", () => {
    // A suggestion with no ZIP must not blank an answer already given.
    expect(block).toContain("suggestion.city ?");
    expect(block).toContain("suggestion.zip ?");
  });

  it("keeps the existing error styling on the field", () => {
    expect(block).toContain("errors.currentStreet");
  });
});
