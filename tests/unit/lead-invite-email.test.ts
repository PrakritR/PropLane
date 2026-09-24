import { describe, expect, it } from "vitest";
import {
  buildLeadInviteEmailBody,
  buildLeadInviteEmailHtml,
  leadInviteSubject,
} from "@/lib/lead-invite-email";

describe("leadInviteSubject", () => {
  it("names a single listing", () => {
    expect(leadInviteSubject("listing", "Ballard Commons")).toBe("Listing: Ballard Commons — PropLane");
  });

  it("counts homes when several listings are shared at once", () => {
    expect(leadInviteSubject("listing", "3 homes", 3)).toBe("3 listings for you — PropLane");
  });

  it("treats a count of 1 as a single listing", () => {
    expect(leadInviteSubject("listing", "Ballard Commons", 1)).toBe("Listing: Ballard Commons — PropLane");
  });

  it("names a lease-to-sign invite", () => {
    expect(leadInviteSubject("lease", "Ballard Commons")).toBe("Sign your lease — Ballard Commons — PropLane");
  });
});

describe("buildLeadInviteEmailBody — lease send", () => {
  it("points the prospect at the create-account lease link", () => {
    const link = "https://app.example.com/auth/create-account?mode=create&role=resident&next=%2Fresident%2Flease";
    const body = buildLeadInviteEmailBody({
      kind: "lease",
      propertyTitle: "Ballard Commons",
      linkUrl: link,
      prospectName: "Sam",
    });
    expect(body).toContain("Hi Sam,");
    expect(body).toContain("sign your lease");
    expect(body).toContain(link);
  });
});

describe("buildLeadInviteEmailBody — multi-listing send", () => {
  const browseUrl = "https://app.example.com/rent/browse?ids=a,b,c";

  it("points the prospect at the filtered browse link with the shared-home count", () => {
    const body = buildLeadInviteEmailBody({
      kind: "listing",
      propertyTitle: "3 homes",
      linkUrl: browseUrl,
      listingCount: 3,
      prospectName: "Sam",
      managerNote: "Take a look!",
    });
    expect(body).toContain("Hi Sam,");
    expect(body).toContain("shared 3 homes");
    expect(body).toContain(browseUrl);
    expect(body).toContain("Take a look!");
    // Multi-listing copy must not fall through to the single-listing "Apply" line.
    expect(body).not.toMatch(/^Apply:/m);
  });

  it("renders an HTML browse CTA for a multi-listing send", () => {
    const html = buildLeadInviteEmailHtml({
      kind: "listing",
      propertyTitle: "2 homes",
      linkUrl: browseUrl,
      listingCount: 2,
    });
    expect(html).toContain("Browse the homes");
    expect(html).toContain(browseUrl);
    expect(html).toContain("2 homes");
  });
});
