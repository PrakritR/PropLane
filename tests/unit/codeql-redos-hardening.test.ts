/**
 * Regression coverage for the CodeQL high-severity hardening pass:
 *   - js/polynomial-redos on the leasing / geocode / pdf regexes
 *     (the manager-intent regexes went with the regex command layer they backed;
 *     the manager SMS surface is an LLM agent now, no hint extraction)
 *   - js/incomplete-url-substring-sanitization on the Apple OAuth diagnostic
 *
 * Each ReDoS case proves two things:
 *   1. Behaviour parity — the shipped function still accepts/rejects and captures
 *      exactly what it did before, across a corpus of realistic + edge inputs.
 *   2. Linear time — an input that made the ORIGINAL pattern backtrack
 *      polynomially now completes near-instantly. We deliberately never run the
 *      original pattern on the pathological input (it would hang the test).
 */
import { describe, expect, it } from "vitest";
import { listingGeocodeQuery } from "@/lib/geocode-address";
import { extractPropertyIdHint, extractPropertyLabelHint } from "@/lib/claw-leasing-links";
import { htmlToBlocks } from "@/lib/reports/export/document-pdf";
// @ts-expect-error — plain .mjs diagnostic script, no type declarations.
import { isAppleRedirectHost } from "../../scripts/diagnose-apple-web-oauth.mjs";

/** Fail if `fn` takes longer than `budgetMs` — the polynomial regexes took seconds. */
function expectFast(fn: () => void, budgetMs = 100): void {
  const start = performance.now();
  fn();
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(budgetMs);
}

describe("geocode listingGeocodeQuery — unit-strip ReDoS", () => {
  const strip = (street: string): string =>
    listingGeocodeQuery({ address: street, zip: "98101", neighborhood: "Ballard", unitLabel: "" });

  it("strips a trailing unit token exactly as before", () => {
    expect(strip("123 Main St, Apt 4B")).toBe("123 Main St, Ballard, 98101, USA");
    expect(strip("500 Pine St Unit 12")).toBe("500 Pine St, Ballard, 98101, USA");
    expect(strip("22 Elm Ave #3")).toBe("22 Elm Ave, Ballard, 98101, USA");
    expect(strip("9 Oak Blvd, Suite 200")).toBe("9 Oak Blvd, Ballard, 98101, USA");
  });

  it("leaves a unit-less street untouched", () => {
    expect(strip("742 Evergreen Terrace")).toBe("742 Evergreen Terrace, Ballard, 98101, USA");
  });

  it("runs in linear time on a long whitespace run", () => {
    const pathological = `123 Main St${"\t".repeat(60_000)}`;
    expectFast(() => strip(pathological));
  });
});

describe("leasing extractPropertyIdHint — separator ReDoS", () => {
  it("still pulls ids from every supported shape", () => {
    expect(extractPropertyIdHint("check propertyId=mgr-abc-1-xyz please")).toBe("mgr-abc-1-xyz");
    expect(extractPropertyIdHint("see /rent/listings/mgr-abc-1-xyz")).toBe("mgr-abc-1-xyz");
    expect(extractPropertyIdHint("listing #abc123def")).toBe("abc123def");
    expect(extractPropertyIdHint("property: mgr-home-2-qqqqqq")).toBe("mgr-home-2-qqqqqq");
    expect(extractPropertyIdHint("no id here")).toBeNull();
  });

  it("removing the redundant /rent/apply? branch keeps propertyId extraction", () => {
    // The deleted branch was unreachable: the first `propertyId=` pattern already
    // matches this via short-circuit, so behaviour is unchanged.
    expect(extractPropertyIdHint("/rent/apply?foo=1&propertyId=mgr-x-9-aaaaaa")).toBe(
      "mgr-x-9-aaaaaa",
    );
  });

  it("runs in linear time on a long separator run", () => {
    const pathological = `listing${" ".repeat(60_000)}`;
    expectFast(() => extractPropertyIdHint(pathological));
  });
});

describe("leasing extractPropertyLabelHint — label-capture ReDoS", () => {
  it("captures the label (period-trimmed) exactly as before", () => {
    expect(extractPropertyLabelHint("Hi — I'd like to schedule a tour for Maple Court.")).toBe(
      "Maple Court",
    );
    expect(extractPropertyLabelHint("Hi — I'd like to apply for Cedar Lofts")).toBe("Cedar Lofts");
    expect(
      extractPropertyLabelHint('Hi — I\'d like to apply for the bundle "A" at Birch Place.'),
    ).toBe("Birch Place");
    expect(extractPropertyLabelHint("I'm interested in Willow Flats.")).toBe("Willow Flats");
  });

  it("runs in linear time on a long trailing whitespace run", () => {
    const pathological = `apply for Cedar${" ".repeat(60_000)}`;
    expectFast(() => extractPropertyLabelHint(pathological));
  });
});

describe("document-pdf htmlToBlocks — <br> normalize ReDoS", () => {
  it("normalizes every <br> shape to a paragraph break as before", () => {
    expect(htmlToBlocks("Line one<br>Line two")).toEqual([
      { kind: "paragraph", text: "Line one" },
      { kind: "paragraph", text: "Line two" },
    ]);
    expect(htmlToBlocks("A< br />B")).toEqual([
      { kind: "paragraph", text: "A" },
      { kind: "paragraph", text: "B" },
    ]);
    expect(htmlToBlocks("<p>Kept</p>")).toEqual([{ kind: "paragraph", text: "Kept" }]);
  });

  it("runs in linear time on a malformed unterminated <br", () => {
    const pathological = `<br${" ".repeat(60_000)}`;
    expectFast(() => htmlToBlocks(pathological));
  });
});

describe("Apple OAuth redirect host allowlist", () => {
  it("accepts the real Apple OAuth host and its subdomains", () => {
    expect(isAppleRedirectHost("https://appleid.apple.com/auth/authorize?client_id=x")).toBe(true);
    expect(isAppleRedirectHost("https://idmsa.appleid.apple.com/")).toBe(true);
  });

  it("rejects look-alike and embedded-host URLs a substring check would accept", () => {
    expect(isAppleRedirectHost("https://evil.example.net/appleid.apple.com")).toBe(false);
    expect(isAppleRedirectHost("https://appleid.apple.com.evil.com/auth")).toBe(false);
    expect(isAppleRedirectHost("https://notappleid.apple.com/")).toBe(false);
    expect(isAppleRedirectHost("http://appleid.apple.com@evil.com/")).toBe(false);
    expect(isAppleRedirectHost(null)).toBe(false);
    expect(isAppleRedirectHost("not a url")).toBe(false);
  });
});
