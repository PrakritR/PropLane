/**
 * Resolving a lease jurisdiction when the property has no structured state.
 *
 * A property saved without a state resolved to no jurisdiction at all, so its lease preview came
 * back empty and the manager was told to "upload or configure this lease" — for a configured
 * PropLane default that needed neither. That is what the ZIP fallback fixes.
 *
 * It is deliberately the LAST signal consulted. A ZIP prefix maps to a state as a postal fact, and
 * it chooses only which jurisdiction's template applies — it never decides what a clause says. So
 * the tests that matter most are the ones proving it cannot override anything more authoritative.
 */
import { describe, expect, it } from "vitest";
import { resolveLeaseJurisdiction } from "@/lib/lease-jurisdiction";

/**
 * What matters is WHICH STATE'S LAW applies. A city-level answer ("seattle") is a Washington
 * jurisdiction with a local overlay, so both count as WA — asserting the exact key would pin
 * incidental address matching rather than the thing that decides the lease.
 */
const stateOf = (j: string) =>
  j === "seattle" || j === "washington" ? "WA" : j === "san_francisco" || j === "california" ? "CA" : "none";

const ctx = (submission: Record<string, unknown>) => ({ submission }) as never;

describe("when nothing else identifies the state", () => {
  it("reads Washington from a WA ZIP", () => {
    // The real case: 4709A 8th Ave NE saved with a ZIP and no state.
    expect(stateOf(resolveLeaseJurisdiction(ctx({ address: "4709A 8th Ave NE", zip: "98015" })))).toBe("WA");
  });

  it("reads California from a CA ZIP", () => {
    expect(stateOf(resolveLeaseJurisdiction(ctx({ address: "100 Main St", zip: "94110" })))).toBe("CA");
  });

  it("stays unsupported for a state PropLane does not generate for", () => {
    // Guessing a template for Texas would be far worse than declining to preview one.
    expect(resolveLeaseJurisdiction(ctx({ address: "100 Main St", zip: "73301" }))).toBe("unsupported");
  });

  it("stays unsupported when there is no ZIP at all", () => {
    expect(resolveLeaseJurisdiction(ctx({ address: "100 Main St" }))).toBe("unsupported");
  });
});

describe("what it must never override", () => {
  it("yields to an explicit out-of-scope state", () => {
    // A Texas property that happens to carry a Seattle-looking number must not become a WA lease.
    expect(resolveLeaseJurisdiction(ctx({ address: "1 Ranch Rd", state: "TX", zip: "98015" }))).toBe(
      "unsupported",
    );
  });

  it("yields to a structured state that disagrees with the ZIP", () => {
    // The structured field is authoritative; a stale or mistyped ZIP cannot move the tenancy.
    expect(resolveLeaseJurisdiction(ctx({ address: "1 Main St", state: "CA", city: "Oakland", zip: "98015" }))).toBe(
      "california",
    );
  });

  it("yields to a city named in the address", () => {
    expect(
      resolveLeaseJurisdiction(ctx({ address: "1 Market St, San Francisco, CA 94105", zip: "94105" })),
    ).toBe("san_francisco");
  });
});

describe("what it does not claim", () => {
  it("resolves a WA state jurisdiction from the ZIP alone", () => {
    // The ZIP fallback itself returns no city; any city-level answer here comes from the address
    // string, which is existing behaviour. Either way the tenancy is governed by WA law.
    expect(stateOf(resolveLeaseJurisdiction(ctx({ address: "4709A 8th Ave NE", zip: "98105" })))).toBe("WA");
  });

  it("ignores a number that is not a ZIP", () => {
    // A unit number or a rent figure must not be read as a postal code.
    expect(resolveLeaseJurisdiction(ctx({ address: "Unit 9801", monthlyRent: "98015" }))).toBe("unsupported");
  });

  it("handles a ZIP+4 without tripping over the suffix", () => {
    expect(stateOf(resolveLeaseJurisdiction(ctx({ address: "4709A 8th Ave NE", zip: "98015-1234" })))).toBe("WA");
  });
});
