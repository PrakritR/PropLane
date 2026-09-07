import { describe, expect, it } from "vitest";
import type { MockProperty } from "@/data/types";
import {
  autoListingSidebarQuickFacts,
  filterListingSidebarQuickFacts,
  listingRichFromManagerSubmission,
} from "@/data/listing-rich-from-submission";
import { buildMockPropertyFromDraft } from "@/lib/demo-property-pipeline";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

function submission(): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.buildingName = "4709A 8th Ave NE";
  const base = sub.rooms[0]!;
  sub.rooms = [1, 2, 3].map((n) => ({ ...base, id: `room-${n}`, name: `Room ${n}`, monthlyRent: 900 + n }));
  sub.bathrooms = [
    { ...sub.bathrooms[0]!, id: "bath-1", name: "Upstairs bath" },
    { ...sub.bathrooms[0]!, id: "bath-2", name: "Half bath" },
  ];
  sub.petFriendly = false;
  return sub;
}

/** The public listing page's own sidebar rows for this submission. */
function publicSidebarRows(sub: ManagerListingSubmissionV1): { label: string; value: string }[] {
  const property: MockProperty = buildMockPropertyFromDraft(
    {
      buildingName: sub.buildingName,
      unitLabel: "Rooms",
      beds: sub.rooms.length,
      baths: 1,
      submission: sub,
    } as never,
    "listing-1",
  );
  return filterListingSidebarQuickFacts(listingRichFromManagerSubmission(property, sub).quickFacts, property);
}

describe("autoListingSidebarQuickFacts (wizard preview of the At a glance card)", () => {
  it("shows exactly the rows the public sidebar derives when no custom facts are set", () => {
    const sub = submission();
    const preview = autoListingSidebarQuickFacts(sub);
    expect(preview).toEqual(publicSidebarRows(sub));
    expect(preview.map((q) => q.label)).toEqual(["Rooms listed", "Bathrooms", "Property & layout", "Pets", "Building"]);
    expect(preview.find((q) => q.label === "Rooms listed")?.value).toBe("3");
    expect(preview.find((q) => q.label === "Bathrooms")?.value).toBe("2");
    expect(preview.find((q) => q.label === "Pets")?.value).toBe("No pets (per submission)");
    expect(preview.find((q) => q.label === "Building")?.value).toBe("4709A 8th Ave NE");
  });

  it("keeps showing the auto-generated rows even when custom rows exist, so the manager can compare", () => {
    const sub = submission();
    sub.quickFacts = [{ id: "qf-1", label: "Parking", value: "Street only" }];
    expect(autoListingSidebarQuickFacts(sub)).toEqual(autoListingSidebarQuickFacts({ ...sub, quickFacts: [] }));
    // and the public page does switch to the custom rows
    expect(publicSidebarRows(sub)).toEqual([{ label: "Parking", value: "Street only" }]);
  });

  it("counts only rooms with a name or a rent, matching the listing page", () => {
    const sub = submission();
    const blank = { ...sub.rooms[0]!, id: "room-blank", name: "", monthlyRent: 0 };
    sub.rooms = [...sub.rooms, blank];
    expect(autoListingSidebarQuickFacts(sub).find((q) => q.label === "Rooms listed")?.value).toBe("3");
  });
});
