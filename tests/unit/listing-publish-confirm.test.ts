/** Publish asks once ("Publish anyway?") when there are no photos or a named room has no price; it never blocks. */
import { describe, expect, it } from "vitest";
import { listingPublishSoftGapsNote } from "@/components/portal/listing-wizard-v2/listing-editor";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { houseDefaultsForSubmission } from "@/lib/listing-house-defaults";

const room = (over: Record<string, unknown>) => ({ ...(createDefaultListingSubmission().rooms[0] ?? {}), ...over });
const build = (over: Partial<ManagerListingSubmissionV1>) =>
  ({ ...createDefaultListingSubmission(), listingPlaceCategoryId: "shared_home", housePhotoDataUrls: [], ...over }) as ManagerListingSubmissionV1;
const note = (s: ManagerListingSubmissionV1) => listingPublishSoftGapsNote(s, houseDefaultsForSubmission(s));

describe("publish soft gaps", () => {
  it("names both gaps in one line", () => {
    const s = build({
      rooms: [
        room({ id: "a", name: "Room A", monthlyRent: "", termPricing: undefined }),
        room({ id: "b", name: "Room B", monthlyRent: "", termPricing: undefined }),
      ] as never,
    });
    expect(note(s)).toBe("No photos yet · 2 rooms have no price.");
  });

  it("names only the photo gap when every room is priced", () => {
    const s = build({ rooms: [room({ id: "a", name: "Room A", monthlyRent: "900" })] as never });
    expect(note(s)).toBe("No photos yet.");
  });

  it("names only the price gap when there is a real photo", () => {
    const s = build({
      housePhotoDataUrls: ["https://cdn.example.com/a.jpg"],
      rooms: [room({ id: "a", name: "Room A", monthlyRent: "" })] as never,
    });
    expect(note(s)).toBe("1 room has no price.");
  });

  it("is silent with a photo and priced rooms", () => {
    const s = build({
      housePhotoDataUrls: ["https://cdn.example.com/a.jpg"],
      rooms: [room({ id: "a", name: "Room A", monthlyRent: "900" })] as never,
    });
    expect(note(s)).toBeNull();
  });

  it("ignores unnamed rooms and counts a data: URL as no photo", () => {
    const s = build({ housePhotoDataUrls: ["data:image/png;base64,AAAA"], rooms: [room({ id: "a", name: "", monthlyRent: "" })] as never });
    expect(note(s)).toBe("No photos yet.");
  });
});
