import { describe, expect, it } from "vitest";
import { isGreetingOnly, PROPLANE_FIRST_TEXT_REPLY, PROPLANE_PROSPECT_FALLBACK_REPLY, PROPLANE_ROLE_QUESTION } from "@/lib/sms/propline-first-text";
import { summarizeLeasingEvidence, TEAM_FOLLOW_UP_REPLY } from "@/lib/agent/leasing-sms-fallback";
import { quietSecondsFor } from "@/lib/sms/prospect-sms-burst.server";

describe("PropLane line first text", () => {
  it.each(["HEY", "hey", "Hi", "hi there!", "Hello?", "heyyy", "Good morning", "  yo "])("%s is a bare greeting", (text) => {
    expect(isGreetingOnly(text)).toBe(true);
  });

  it.each(["hey is there anything near UW", "Is there any houses in seattle", "hi, how much is rent?", "", "STOP", "yes"])(
    "%s goes to the agent",
    (text) => expect(isGreetingOnly(text)).toBe(false),
  );

  it("the fixed reply is the role question: one GSM-7 segment with no long dash", () => {
    expect(PROPLANE_FIRST_TEXT_REPLY).toBe("Hi, this is PropLane. Are you a resident, a vendor, looking for a place, or want to manage your own property with PropLane?");
    expect(PROPLANE_FIRST_TEXT_REPLY).toBe(PROPLANE_ROLE_QUESTION);
    for (const reply of [PROPLANE_FIRST_TEXT_REPLY, PROPLANE_PROSPECT_FALLBACK_REPLY]) {
      expect(reply.length).toBeLessThanOrEqual(160);
      expect(reply).toMatch(/^[\x20-\x7E]+$/);
      expect(reply).not.toMatch(/[–—]/);
    }
    expect(PROPLANE_PROSPECT_FALLBACK_REPLY).toBe("Hi, this is PropLane. Looking for a place to rent? Tell me the area, budget and move-in date.");
  });

  it("a finished question waits less than a fragment", () => {
    expect(quietSecondsFor("Is there any houses in seattle")).toBe(5);
    expect(quietSecondsFor("anything near UW?")).toBe(5);
    expect(quietSecondsFor("District")).toBe(10);
    expect(quietSecondsFor("UDistrict near campus")).toBe(10);
    expect(quietSecondsFor("")).toBe(10);
  });
});

describe("deterministic prospect summary", () => {
  const listing = (extra: Record<string, unknown>) => ({
    title: "5257 Brooklyn Ave NE", neighborhood: "University District", lowestRoomRent: 900,
    listingUrl: "https://proplane.ai/rent/listings/p1", areaMatch: { how: "distance", distanceMiles: 0.9, near: true }, ...extra,
  });

  it("lists homes near the place with the tool's own links", () => {
    const reply = summarizeLeasingEvidence([{
      tool: "list_live_listings", input: {},
      output: { count: 1, listings: [listing({})], browseUrl: "https://proplane.ai/rent/browse", area: { resolved: true, place: "the University of Washington campus", nearCount: 1 } },
    }]);
    expect(reply).toContain("5257 Brooklyn Ave NE");
    expect(reply).toContain("0.9 mi away");
    expect(reply).toContain("https://proplane.ai/rent/listings/p1");
    expect(reply).not.toMatch(/can't verify/i);
  });

  it("says plainly when nothing is in the area and gives the closest", () => {
    const reply = summarizeLeasingEvidence([{
      tool: "list_live_listings", input: {},
      output: { count: 1, listings: [listing({ areaMatch: { how: "distance", distanceMiles: 4.2, near: false } })], area: { resolved: true, place: "West Seattle", nearCount: 0 } },
    }]);
    expect(reply).toMatch(/do not see a home right at West Seattle/);
    expect(reply).toContain("4.2 mi away");
  });

  it("falls back to the team follow-up line when nothing was looked up, never the portal sentence", () => {
    expect(summarizeLeasingEvidence([])).toBe(TEAM_FOLLOW_UP_REPLY);
    expect(TEAM_FOLLOW_UP_REPLY).not.toMatch(/verify/i);
  });
});
