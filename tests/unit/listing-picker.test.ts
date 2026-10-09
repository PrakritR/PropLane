import { describe, expect, it } from "vitest";

import {
  LISTING_PICKER_HELD_LABEL,
  LISTING_PICKER_READY_LABEL,
  listingPickerHoldReason,
  listingPickerLabel,
  listingPickerOptions,
  listingPickerSourceFromProperty,
  type ListingPickerSource,
} from "@/lib/listing-channels/listing-picker";
import { taggedLinkFromPostText } from "@/lib/listing-channels/post-text";
import type { MockProperty } from "@/data/types";

const src = (over: Partial<ListingPickerSource> & { id: string }): ListingPickerSource => ({
  status: "live",
  name: over.id,
  roomCount: 0,
  holdReasons: [],
  ...over,
});

describe("listingPickerLabel", () => {
  it("is the name plus the room count", () => {
    expect(listingPickerLabel("5257 Brooklyn Ave", 10)).toBe("5257 Brooklyn Ave · 10 rooms");
    expect(listingPickerLabel("Maple House", 1)).toBe("Maple House · 1 room");
  });
  it("leaves the count off when no rooms are entered, and never prints an empty name", () => {
    expect(listingPickerLabel("Maple House", 0)).toBe("Maple House");
    expect(listingPickerLabel("  ", 0)).toBe("Untitled listing");
  });
});

describe("listingPickerHoldReason", () => {
  it("sentence-cases the hold fact without the Held: lead", () => {
    expect(listingPickerHoldReason(["no_photo"])).toBe("No photo");
    expect(listingPickerHoldReason(["no_street_address", "no_photo"])).toBe("No street address and no photo");
    expect(listingPickerHoldReason(["no_work_number"])).toBe("Set up work number");
  });
});

describe("listingPickerOptions", () => {
  it("groups Ready to post before Held, each sorted by label, held with its reason", () => {
    const { groups, firstId } = listingPickerOptions([
      src({ id: "b", name: "Birch Flats", roomCount: 9 }),
      src({ id: "h2", name: "Proof Term Long", holdReasons: ["no_photo"] }),
      src({ id: "a", name: "5257 Brooklyn Ave", roomCount: 10 }),
      src({ id: "h1", name: "Proof Term Both", holdReasons: ["no_photo"] }),
    ]);
    expect(groups.map((g) => g.label)).toEqual([LISTING_PICKER_READY_LABEL, LISTING_PICKER_HELD_LABEL]);
    expect(groups[0]!.options.map((o) => o.label)).toEqual(["5257 Brooklyn Ave · 10 rooms", "Birch Flats · 9 rooms"]);
    expect(groups[1]!.options.map((o) => o.label)).toEqual(["Proof Term Both · No photo", "Proof Term Long · No photo"]);
    expect(firstId).toBe("a");
  });

  it("excludes drafts, even ready ones", () => {
    const { groups } = listingPickerOptions([src({ id: "d", status: "draft" }), src({ id: "x", name: "X" })]);
    expect(groups.flatMap((g) => g.options.map((o) => o.value))).toEqual(["x"]);
  });

  it("leaves out an empty group and falls back to the first held listing for the default", () => {
    const only = listingPickerOptions([src({ id: "h", holdReasons: ["no_photo"] })]);
    expect(only.groups.map((g) => g.label)).toEqual([LISTING_PICKER_HELD_LABEL]);
    expect(only.firstId).toBe("h");
    expect(listingPickerOptions([])).toEqual({ groups: [], firstId: "" });
  });
});

describe("listingPickerSourceFromProperty", () => {
  const property = {
    id: "p1",
    title: "Proof Term Long",
    buildingName: "Proof Term Long",
    address: "5257 Brooklyn Avenue Northeast, Seattle, WA 98105",
    listingSubmission: { rooms: [{}, {}, {}] },
  } as unknown as MockProperty;

  it("uses the house name, counts rooms, and holds a listing with no photo", () => {
    const s = listingPickerSourceFromProperty(property, { status: "live", workNumberSet: true });
    expect(s.name).toBe("Proof Term Long");
    expect(s.roomCount).toBe(3);
    expect(s.holdReasons).toContain("no_photo");
  });

  it("falls back to the short street when the house has no real name, and adds the work-number hold", () => {
    const s = listingPickerSourceFromProperty({ ...property, title: "2", buildingName: "2" } as MockProperty, { status: "live", workNumberSet: false });
    expect(s.name).toBe("5257 Brooklyn Avenue Northeast");
    expect(s.holdReasons).toContain("no_work_number");
  });
});

describe("taggedLinkFromPostText", () => {
  it("reads the tagged link out of a built post", () => {
    expect(taggedLinkFromPostText("Head\n\nDetails and photos: https://proplane.ai/l/p1?src=craigslist\nText (206) 555-0100")).toBe(
      "https://proplane.ai/l/p1?src=craigslist",
    );
    expect(taggedLinkFromPostText("no link here")).toBe("");
  });
});
