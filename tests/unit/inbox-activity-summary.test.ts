import { describe, expect, it } from "vitest";
import { inboxActivitySummary } from "@/lib/inbox-activity-summary";
import { inboxCounterpartyName } from "@/lib/manager-inbox-contacts";

describe("compact communication presentation", () => {
  it("keeps the authored event title and extracts its record link and property", () => {
    expect(inboxActivitySummary("Application fee $50.00 created", "Hi Alex,\nThe charge was created.\nProperty: Pine House\nView it here: https://example.com/payment/1.")).toEqual({title: "Application fee $50.00 created", property: "Pine House", href: "https://example.com/payment/1"});
  });
  it("formats the authoritative amount in the exact charge-created template", () => {
    expect(inboxActivitySummary("Application fee · Payment update", 'The 50 charge for “Application fee” at Pine House was created.')).toEqual({title: "Application fee $50.00 created", property: "Pine House", href: undefined});
  });
  it("does not turn arbitrary non-http text into a record link", () => {
    expect(inboxActivitySummary(undefined, "Task completed\nView it here: javascript:alert(1)")).toEqual({title: "Task completed", property: undefined, href: undefined});
  });
  it("prefers directory names and preserves explicit sender names", () => {
    expect(inboxCounterpartyName("occupancy.jamie@example.com", "Jamie Lee", [])).toBe("Jamie Lee");
    expect(inboxCounterpartyName("occupancy.baljinnya@example.com", undefined, [])).toBe("Baljinnya");
    expect(inboxCounterpartyName("aaron@example.com", '"Aaron Smith" <aaron@example.com>', [])).toBe("Aaron Smith");
  });
});
