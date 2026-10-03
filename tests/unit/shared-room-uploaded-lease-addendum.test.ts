import { describe, expect, it } from "vitest";
import {
  appendSharedRoomAddendumToLeaseHtml,
  buildSharedRoomUploadedLeaseAddendumHtml,
} from "@/lib/shared-room-uploaded-lease-addendum";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { LeaseGenerationContext } from "@/lib/generated-lease";

function sharedRoomCtx(joint = true): LeaseGenerationContext {
  let submission = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
  submission = {
    ...submission,
    rooms: [
      {
        ...submission.rooms[0]!,
        id: "room-shared",
        name: "Shared room",
        monthlyRent: 900,
        occupancyCapacity: 2,
        sharedRoomLeaseKind: joint ? "joint" : "individual",
      },
    ],
  };
  return {
    application: {
      fullLegalName: "Alex Resident",
      roomChoice1: "room-shared",
      residentSlot: 1,
      leaseTerm: "12-Month",
    },
    leasedRoom: undefined,
    listingProperty: { address: "123 Main St", buildingName: "Test House" } as LeaseGenerationContext["listingProperty"],
    submission,
    generatedAtIso: "2026-10-03T00:00:00.000Z",
  };
}

describe("shared-room uploaded lease addendum (C2-SR12)", () => {
  it("builds bed, rent, and joint-lease language for a shared room", () => {
    const html = buildSharedRoomUploadedLeaseAddendumHtml(sharedRoomCtx());
    expect(html).toContain("Shared room addendum");
    expect(html).toContain("Bed A");
    expect(html).toContain("$900");
    expect(html).toContain("joint lease");
  });

  it("appends the addendum before </body> when present", () => {
    const base = "<!doctype html><html><body><p>Lease</p></body></html>";
    const merged = appendSharedRoomAddendumToLeaseHtml(sharedRoomCtx(), base);
    expect(merged).toContain("Shared room addendum");
    expect(merged.indexOf("Shared room addendum")).toBeGreaterThan(merged.indexOf("<p>Lease</p>"));
  });

  it("returns the original html for a private room", () => {
    const ctx = sharedRoomCtx();
    ctx.submission!.rooms[0]!.occupancyCapacity = 1;
    const base = "<html><body>Private</body></html>";
    expect(appendSharedRoomAddendumToLeaseHtml(ctx, base)).toBe(base);
  });
});
