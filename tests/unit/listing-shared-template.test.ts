import { describe, expect, it } from "vitest";
import { DEFAULT_LISTING_SHARED_INTRO, renderListingSharedIntro } from "@/lib/listing-shared-template";
import { buildLeadInviteEmailBody, buildLeadInviteEmailHtml } from "@/lib/lead-invite-email";

describe("listing shared review and delivery", () => {
  it("fills the Settings tokens with actual selected homes and first name", () => {
    expect(renderListingSharedIntro("{first_name}, {homes}: {property}", { count: 2, property: "Cedar, Birch", name: "Sam Smith" })).toBe("Sam, 2 homes: Cedar, Birch");
    expect(renderListingSharedIntro(DEFAULT_LISTING_SHARED_INTRO, { count: 1, property: "Cedar" })).toContain("shared Cedar");
  });
  it("uses one combined link, photo-less cards, editable intro, and signature in both representations", () => {
    const params = { kind: "listing" as const, propertyTitle: "2 homes", linkUrl: "https://example.com/rent/browse?ids=a,b", listingShare: { intro: "Welcome <Sam>", listings: [{ title: "Cedar", detailLines: ["$1,200/mo", "2 baths"] }, { title: "Birch", detailLines: ["$900/mo"] }], signature: ["Alex", "+12065551234", "alex@example.com"] } };
    const text = buildLeadInviteEmailBody(params);
    const html = buildLeadInviteEmailHtml(params);
    expect(text).toContain("Hi there,");
    expect(text).toContain("Welcome <Sam>");
    expect(html).toContain("Welcome &lt;Sam&gt;");
    expect(html).toContain("View listings");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain("<img");
    for (const part of ["Cedar", "Birch", "$1,200/mo", "Alex", "+12065551234", "alex@example.com"]) {
      expect(text).toContain(part);
      expect(html).toContain(part);
    }
  });
});
