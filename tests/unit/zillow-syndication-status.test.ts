import { describe, expect, it } from "vitest";
import { resolveZillowSyndicationStatus } from "@/lib/listing-syndication/zillow-syndication-status";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const baseSub = (): ManagerListingSubmissionV1 =>
  ({
    address: "123 Main St",
    housePhotoDataUrls: ["https://example.com/p.jpg"],
    rooms: [{ id: "r1", name: "Room 1" }],
    syndication: { zillow: { enabled: true, sentAt: "2026-10-01T12:00:00.000Z", status: "sent" } },
  }) as ManagerListingSubmissionV1;

describe("resolveZillowSyndicationStatus", () => {
  it("reports blockers when address or photo missing", () => {
    const sub = baseSub();
    sub.address = "";
    const status = resolveZillowSyndicationStatus({ sub, listingStatus: "live" });
    expect(status.code).toBe("blocked");
    expect(status.text).toContain("street address");
  });

  it("reads live when syndication sent on a listed home", () => {
    const sub = baseSub();
    sub.syndication!.zillow!.status = "live";
    const status = resolveZillowSyndicationStatus({ sub, listingStatus: "live" });
    expect(status.code).toBe("live");
    expect(status.text).toMatch(/Live/);
  });
});
