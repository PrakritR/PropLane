/**
 * Default bathroom — saved on the listing, inferred for older ones, and judged
 * per field the way the rooms are. Shared spaces have no Default card any
 * more; their reader below only keeps an older listing's stored block legible.
 */
import { describe, expect, it } from "vitest";
import {
  applyBathroomDefaults,
  bathroomDefaultsForSubmission,
  emptyBathroomDefaults,
  emptySharedSpaceDefaults,
  recordFollowsDefault,
  sharedSpaceDefaultsForSubmission,
  writeBathroomField,
} from "@/lib/listing-record-defaults";
import { emptyBathroom, emptySharedSpace } from "@/lib/manager-listing-submission";

describe("recordFollowsDefault", () => {
  it("follows on a match, on a blank, and when the default is blank", () => {
    expect(recordFollowsDefault("2nd floor", "2nd floor")).toBe(true);
    expect(recordFollowsDefault("", "2nd floor")).toBe(true);
    expect(recordFollowsDefault("2nd floor", "")).toBe(true);
    expect(recordFollowsDefault("1st floor", "2nd floor")).toBe(false);
    expect(recordFollowsDefault(["a"], ["a"])).toBe(true);
    expect(recordFollowsDefault(["a"], ["b"])).toBe(false);
    expect(recordFollowsDefault(null, "clip")).toBe(true);
  });
});

describe("bathroomDefaultsForSubmission", () => {
  it("prefers what the listing stored, and infers the rest from the bathrooms", () => {
    const b1 = { ...emptyBathroom(0), location: "1st floor", photoDataUrls: ["p"] };
    const b2 = { ...emptyBathroom(1), location: "1st floor", photoDataUrls: ["p"] };
    const b3 = { ...emptyBathroom(2), location: "2nd floor", photoDataUrls: ["q"] };
    const inferred = bathroomDefaultsForSubmission({ bathrooms: [b1, b2, b3], bathroomDefaults: undefined });
    expect(inferred.location).toBe("1st floor");
    // Two of three share a photo: not the house's.
    expect(inferred.photoDataUrls).toEqual([]);
    const stored = bathroomDefaultsForSubmission({ bathrooms: [b1, b2, b3], bathroomDefaults: { location: "Basement" } });
    expect(stored.location).toBe("Basement");
    expect(bathroomDefaultsForSubmission({ bathrooms: [], bathroomDefaults: undefined })).toEqual(emptyBathroomDefaults());
  });

  it("a fresh card copies every default that is set, and only those", () => {
    const d = { ...emptyBathroomDefaults(), location: "2nd floor", type: "half" as const, photoDataUrls: ["p"] };
    const bath = applyBathroomDefaults(emptyBathroom(0), d);
    expect(bath.location).toBe("2nd floor");
    expect(bath.bathtub).toBe(false);
    expect(bath.shower).toBe(false);
    expect(bath.photoDataUrls).toEqual(["p"]);
    expect(bath.detail ?? "").toBe("");
    expect(writeBathroomField(bath, "videoDataUrl", "v").videoDataUrl).toBe("v");
    expect(writeBathroomField(bath, "videoDataUrl", null).videoDataUrl).toBeNull();
  });
});

describe("sharedSpaceDefaultsForSubmission (read-only: older listings keep reading)", () => {
  it("infers a clip only when every space shares it", () => {
    const s1 = { ...emptySharedSpace(0), videoDataUrl: "v", detail: "Sunny" };
    const s2 = { ...emptySharedSpace(1), videoDataUrl: "v", detail: "Sunny" };
    expect(sharedSpaceDefaultsForSubmission({ sharedSpaces: [s1, s2], sharedSpaceDefaults: undefined })).toMatchObject({ videoDataUrl: "v", detail: "Sunny" });
    expect(sharedSpaceDefaultsForSubmission({ sharedSpaces: [s1, { ...s2, videoDataUrl: null }], sharedSpaceDefaults: undefined }).videoDataUrl).toBeNull();
  });

  it("a stored block from a listing saved with the old Default card still reads, over the inference", () => {
    const s1 = { ...emptySharedSpace(0), location: "1st floor" };
    const s2 = { ...emptySharedSpace(1), location: "1st floor" };
    const stored = sharedSpaceDefaultsForSubmission({ sharedSpaces: [s1, s2], sharedSpaceDefaults: { location: "Basement", detail: "Shared by all" } });
    expect(stored.location).toBe("Basement");
    expect(stored.detail).toBe("Shared by all");
    // Reading never touches the spaces themselves: each keeps its own copy.
    expect(s1.location).toBe("1st floor");
    expect(s2.location).toBe("1st floor");
  });

  it("a listing with no spaces and no stored block reads the empty defaults", () => {
    expect(sharedSpaceDefaultsForSubmission({ sharedSpaces: [], sharedSpaceDefaults: undefined })).toEqual(emptySharedSpaceDefaults());
    expect(sharedSpaceDefaultsForSubmission({ sharedSpaces: undefined, sharedSpaceDefaults: undefined })).toEqual(emptySharedSpaceDefaults());
  });
});
