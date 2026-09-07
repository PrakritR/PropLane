import { describe, expect, it } from "vitest";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import {
  inboxCounterpartyName,
  parsePropertyAudienceKey,
  propertyAudienceKey,
  propertyAudienceOptions,
  residentsForPropertyAudience,
} from "@/lib/manager-inbox-contacts";

/**
 * PRP-315: a manager can message the residents of ONE house, and the
 * conversation list names people rather than printing their addresses.
 */
const contacts: InboxScopedContact[] = [
  { id: "r1", name: "Mason Clark", email: "mason.clark@example.com", role: "resident", propertyId: "cascade", propertyLabel: "Cascade Lofts", tenancyStatus: "resident" },
  { id: "r2", name: "Olivia Brooks", email: "olivia@example.com", role: "resident", propertyId: "cascade", propertyLabel: "Cascade Lofts", tenancyStatus: "resident" },
  { id: "r3", name: "Past Person", email: "past@example.com", role: "resident", propertyId: "cascade", propertyLabel: "Cascade Lofts", tenancyStatus: "past" },
  { id: "r4", name: "Applicant Amy", email: "amy@example.com", role: "resident", propertyId: "cascade", propertyLabel: "Cascade Lofts", tenancyStatus: "applicant" },
  { id: "r5", name: "Lake Resident", email: "lake@example.com", role: "resident", propertyId: "lakeview", propertyLabel: "Lakeview Studio", tenancyStatus: "resident" },
  { id: "r6", name: "Only Applicant", email: "only@example.com", role: "resident", propertyId: "empty-house", propertyLabel: "Empty House", tenancyStatus: "applicant" },
  { id: "v1", name: "Plumber Pro", email: "plumber@example.com", role: "vendor" },
];

describe("per-property audience (PRP-315)", () => {
  it("offers one option per property that has a current resident, sorted by house", () => {
    const options = propertyAudienceOptions(contacts);
    expect(options.map((o) => o.label)).toEqual(["All residents · Cascade Lofts", "All residents · Lakeview Studio"]);
    expect(options.map((o) => o.key)).toEqual([propertyAudienceKey("cascade"), propertyAudienceKey("lakeview")]);
    // A house with only an applicant has nobody living in it yet.
    expect(options.some((o) => o.propertyId === "empty-house")).toBe(false);
  });

  it("expands to the house's current residents only — no applicants, no one who moved out", () => {
    const emails = residentsForPropertyAudience(contacts, "cascade").map((c) => c.email);
    expect(emails).toEqual(["mason.clark@example.com", "olivia@example.com"]);
  });

  it("round-trips the audience key and ignores other keys", () => {
    expect(parsePropertyAudienceKey(propertyAudienceKey("cascade"))).toBe("cascade");
    expect(parsePropertyAudienceKey("broadcast:resident")).toBeNull();
    expect(parsePropertyAudienceKey("id:r1")).toBeNull();
    expect(parsePropertyAudienceKey("broadcast:property:")).toBeNull();
  });
});

describe("conversation titles use names (PRP-315)", () => {
  it("names a directory contact by their name, whatever the thread's from field says", () => {
    expect(inboxCounterpartyName("Mason.Clark@example.com", "mason.clark@example.com", contacts)).toBe("Mason Clark");
    expect(inboxCounterpartyName("mason.clark@example.com", null, contacts)).toBe("Mason Clark");
  });

  it("falls back to the sender name, then the address, for someone outside the directory", () => {
    expect(inboxCounterpartyName("stranger@example.com", "A Stranger", contacts)).toBe("A Stranger");
    expect(inboxCounterpartyName("stranger@example.com", "", contacts)).toBe("stranger@example.com");
    expect(inboxCounterpartyName("stranger@example.com", null, undefined)).toBe("stranger@example.com");
  });

  it("does not treat a contact whose name is just their email as a name", () => {
    const bare: InboxScopedContact[] = [{ id: "x", name: "x@example.com", email: "x@example.com", role: "resident" }];
    expect(inboxCounterpartyName("x@example.com", "From Header", bare)).toBe("From Header");
  });
});
