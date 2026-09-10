// @vitest-environment node
/**
 * The public "Email" CTA.
 *
 * The leasing email assistant has been wired since the work email shipped, and
 * no surface ever showed a prospect the address, so it could not be reached.
 * The rules here mirror the SMS CTA's: a resolved address or nothing — never a
 * dead `mailto:`, and never a manager's personal mailbox.
 */
import { describe, expect, it } from "vitest";
import {
  buildListingEmailDeepLink,
  isListingCtaEmailEnabled,
  listingCtaEmailAddress,
} from "@/lib/listing-cta-email";

describe("listingCtaEmailAddress", () => {
  it("accepts a work address and normalizes it", () => {
    expect(listingCtaEmailAddress("  Assist-Jane-Smith@Prop-Lane.Space ")).toBe(
      "assist-jane-smith@prop-lane.space",
    );
  });

  it.each([null, undefined, "", "   ", "nope", "no@domain", "@prop-lane.space", "a@b.", "two words@x.com"])(
    "rejects %s rather than rendering a dead link",
    (value) => {
      expect(listingCtaEmailAddress(value)).toBeNull();
      expect(isListingCtaEmailEnabled(value)).toBe(false);
    },
  );
});

describe("buildListingEmailDeepLink", () => {
  const to = "assist-jane@prop-lane.space";

  it("returns '#' with no usable address so callers must omit the button", () => {
    expect(buildListingEmailDeepLink({ intent: "tour", toEmail: null })).toBe("#");
    expect(buildListingEmailDeepLink({ intent: "tour", toEmail: "nope" })).toBe("#");
  });

  it("names the listing in the tour subject and body", () => {
    const href = buildListingEmailDeepLink({ intent: "tour", propertyLabel: "5257 Brooklyn", toEmail: to });
    expect(href.startsWith(`mailto:${to}?`)).toBe(true);
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(params.get("subject")).toBe("Tour request — 5257 Brooklyn");
    expect(params.get("body")).toBe("Hi — I'd like to schedule a tour for 5257 Brooklyn.");
  });

  it("falls back to generic copy with no label", () => {
    const href = buildListingEmailDeepLink({ intent: "apply", toEmail: to });
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(params.get("subject")).toBe("Application");
    expect(params.get("body")).toBe("Hi — I'd like to apply.");
  });

  it("carries a question topic through", () => {
    const href = buildListingEmailDeepLink({
      intent: "question",
      topic: "parking",
      propertyLabel: "5257 Brooklyn",
      toEmail: to,
    });
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(params.get("subject")).toBe("Question about parking — 5257 Brooklyn");
    expect(params.get("body")).toContain("parking");
  });

  it("escapes an address and label rather than breaking the URL", () => {
    const href = buildListingEmailDeepLink({
      intent: "tour",
      propertyLabel: "A & B #3",
      toEmail: to,
    });
    expect(href).not.toContain(" ");
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(params.get("subject")).toBe("Tour request — A & B #3");
  });
});
