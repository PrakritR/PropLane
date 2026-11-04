import { describe, expect, it } from "vitest";
import { quoteEmailEvidence } from "@/lib/vendor-sourcing-search.server";
const at = "2026-10-18T12:00:00.000Z";
describe("purchasing inquiry email evidence", () => {
  it("retains an exact invitation from the business domain", () => {
    expect(quoteEmailEvidence("https://plumber.example/quotes", ["Email quotes@plumber.example for a service quote"], at)).toMatchObject({ email: "quotes@plumber.example", source: "published_quote_invitation", followUpAllowed: false, recordedAt: at });
  });
  it.each([
    ["https://plumber.example", "Contact us at info@plumber.example"],
    ["https://plumber.example", "Email another@other.example for a quote"],
    ["https://yelp.com/business", "Email quotes@yelp.com for a quote"],
    ["https://plumber.example", "Email a@plumber.example or b@plumber.example for a quote"],
    ["https://plumber.example", "Email info@plumber.example. Request a quote online"],
  ])("rejects unsupported eligibility %s", (url, text) => { expect(quoteEmailEvidence(url, [text], at)).toBeNull(); });
});
