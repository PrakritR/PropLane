import { describe, expect, it } from "vitest";
import { splitCommaSeparatedList, splitLineList, listingAmenityLinesFromValue } from "@/data/manager-listing-presets";

describe("splitCommaSeparatedList", () => {
  it("preserves spaces inside a phrase while typing", () => {
    expect(splitCommaSeparatedList("pool table")).toEqual(["pool table"]);
    expect(splitCommaSeparatedList("pool ")).toEqual(["pool "]);
  });

  it("splits completed comma-separated entries", () => {
    expect(splitCommaSeparatedList("pool table, hot tub")).toEqual(["pool table", "hot tub"]);
  });

  it("keeps a trailing comma visible while starting the next entry", () => {
    expect(splitCommaSeparatedList("pool table,")).toEqual(["pool table", ""]);
  });

  it("still trims whitespace on completed segments", () => {
    expect(splitCommaSeparatedList("pool table , hot tub")).toEqual(["pool table", "hot tub"]);
  });
});

describe("listingAmenityLinesFromValue", () => {
  it("preserves spaces inside a stored custom amenity line", () => {
    expect(listingAmenityLinesFromValue("Heating\npool table")).toEqual(["Heating", "pool table"]);
    expect(listingAmenityLinesFromValue("pool table ")).toEqual(["pool table "]);
  });
});

describe("splitLineList vs amenities Other input", () => {
  it("splitLineList eats trailing spaces (why Other must not use it on change)", () => {
    expect(splitLineList("pool ")).toEqual(["pool"]);
  });
});
