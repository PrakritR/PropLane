/** design-1112 §6: every lead mail is read - by the site's parser when verified or switched on, else by the generic fallback. */
import { describe, expect, it } from "vitest";
import { leadSiteOfAddress, parseGenericLead, parsePlatformLead, phoneInText, PLATFORM_LEAD_PARSER_VERIFIED, type PlatformLeadSite } from "@/lib/inbound-email/platform-lead-parsers";
import { ALL_PLATFORM_FIXTURES } from "../fixtures/platform-mail";

const ALL_ON = new Set<PlatformLeadSite>(["roomies", "zillow", "craigslist", "facebook", "roomster", "spareroom"]);
const input = (f: (typeof ALL_PLATFORM_FIXTURES)[number]) => ({ fromEmail: f.fromEmail, fromName: f.fromName, subject: f.subject, text: f.text, replyTo: f.replyTo });

describe("sender domain decides the site", () => {
  it("recognises each site's own domains and subdomains, never a look-alike", () => {
    expect(leadSiteOfAddress("noreply@convo.zillow.com")).toBe("zillow");
    expect(leadSiteOfAddress("x@reply.craigslist.org")).toBe("craigslist");
    expect(leadSiteOfAddress("n@facebookmail.com")).toBe("facebook");
    expect(leadSiteOfAddress("x@spareroom.co.uk")).toBe("spareroom");
    for (const fake of ["x@zillow.com.evil.test", "x@notzillow.com", "x@craigslist.org.example.io", "x@gmail.com"]) expect(leadSiteOfAddress(fake)).toBeNull();
  });
  it("parsePlatformLead is null for a sender that is no lead site", () => {
    expect(parsePlatformLead({ fromEmail: "a@gmail.com", subject: "hi", text: "hello there" })).toBeNull();
  });
});

describe("site parsers (switched on)", () => {
  for (const fixture of ALL_PLATFORM_FIXTURES) {
    it(`${fixture.expect.site}: reads the sender, message, listing and phone`, () => {
      const lead = parsePlatformLead(input(fixture), { enabled: ALL_ON })!;
      expect(lead).not.toBeNull();
      expect(lead.site).toBe(fixture.expect.site);
      expect(lead.senderName).toBe(fixture.expect.senderName);
      expect(lead.body).toContain(fixture.expect.bodyIncludes);
      if (fixture.expect.listingIncludes) expect(`${lead.listingHint} ${lead.roomHint}`).toContain(fixture.expect.listingIncludes);
      expect(lead.phoneInBody).toBe(fixture.expect.phone);
      expect(lead.via).toBe("site");
    });
  }
});

describe("unverified sites are OFF by default and take the generic fallback", () => {
  it("only SpareRoom's parser is marked verified", () => {
    expect(Object.entries(PLATFORM_LEAD_PARSER_VERIFIED).filter(([, v]) => v).map(([k]) => k)).toEqual(["spareroom"]);
  });
  for (const fixture of ALL_PLATFORM_FIXTURES.filter((f) => f.expect.site !== "spareroom")) {
    it(`${fixture.expect.site}: nothing is dropped with the site parser off`, () => {
      const lead = parsePlatformLead(input(fixture), { enabled: new Set() })!;
      expect(lead).not.toBeNull();
      expect(lead.site).toBe(fixture.expect.site);
      expect(lead.via).toBe("generic");
      expect(lead.body).toContain(fixture.expect.bodyIncludes);
    });
  }
  it("a reworded mail the site parser cannot read still lands through the generic reader", () => {
    const lead = parsePlatformLead({ fromEmail: "noreply@roomies.com", fromName: "Roomies", subject: "You have a new notification", text: "Somebody wants to chat\n\nCan I see the room on Friday?\n\nRoomies Inc." }, { enabled: new Set<PlatformLeadSite>(["roomies"]) })!;
    expect(lead.via).toBe("generic");
    expect(lead.body).toContain("Can I see the room on Friday?");
  });
  it("a mail with no readable message is null (stored, nothing answered)", () => {
    expect(parseGenericLead("zillow", { fromEmail: "x@zillow.com", subject: "", text: "" })).toBeNull();
  });
});

describe("relay address and phone", () => {
  it("keeps a reply address only on the site's own domain", () => {
    const f = { ...ALL_PLATFORM_FIXTURES[0], replyTo: "evil@attacker.test" };
    expect(parsePlatformLead(input(f), { enabled: ALL_ON })!.replyAddress).toBeNull();
    expect(parsePlatformLead(input(ALL_PLATFORM_FIXTURES[0]), { enabled: ALL_ON })!.replyAddress).toBe("reply-71ab@spareroom.com");
  });
  it("never reads PropLane's own line (quoted history) as the prospect's phone", () => {
    expect(phoneInText("Please TEXT (206) 678-1909. My cell is 425-555-0100", ["+12066781909"])).toBe("+14255550100");
    expect(phoneInText("Text (206) 678-1909 only", ["+12066781909"])).toBeNull();
    expect(phoneInText("Move in 2026-12-01 for $1,100", [])).toBeNull();
  });
});
