import { describe, expect, it } from "vitest";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import {
  disclosureRulesCatalog,
  disclosureVerbatimHtml,
  disclosureVerbatimHtmlForSection,
  evaluateDisclosureRules,
  parseDisclosureRulesCatalog,
} from "@/lib/lease-templates/disclosure-rules";
import { CALIFORNIA_LEASE_CONFIG, SAN_FRANCISCO_LEASE_CONFIG, SEATTLE_LEASE_CONFIG } from "@/lib/lease-templates/types";
import { createDefaultListingSubmission, emptyRoom } from "@/lib/manager-listing-submission";
import type { LeaseGenerationContext } from "@/lib/generated-lease";

function leaseContext(address: string, yearBuilt?: number): LeaseGenerationContext {
  const submission = {
    ...createDefaultListingSubmission(),
    buildingName: "Disclosure House",
    address,
    yearBuilt,
    securityDeposit: "400",
    rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 1200 }],
  };
  return {
    application: {
      fullLegalName: "Disclosure Resident",
      leaseTerm: "12-Month",
      leaseStart: "2026-08-01",
      leaseEnd: "2027-07-31",
      roomChoice1: "property-1::room-1",
    },
    leasedRoom: undefined,
    listingProperty: {
      id: "property-1",
      title: "Disclosure House",
      address,
      buildingName: "Disclosure House",
      unitLabel: "Room 1",
    } as LeaseGenerationContext["listingProperty"],
    submission,
    generatedAtIso: "2026-08-01T00:00:00.000Z",
  };
}

function ids(result: ReturnType<typeof evaluateDisclosureRules>): string[] {
  return result.firedRules.map((rule) => rule.id);
}

describe("disclosure rules catalog evaluator", () => {
  const leadRule = disclosureRulesCatalog.rules.find((rule) => rule.id === "fed-lead-paint");
  if (!leadRule?.verbatim_text) throw new Error("Expected the real catalog to include fed-lead-paint verbatim text");

  it("renders the real pre-1978 lead rule verbatim once, at its existing section", () => {
    const html = buildLeaseHtml(leaseContext("1 Market St, San Francisco, CA 94105", 1977), SAN_FRANCISCO_LEASE_CONFIG);
    const rendered = `<p data-disclosure-rule="fed-lead-paint">${leadRule.verbatim_text}</p>`;

    expect(html).toContain("Lead-Based Paint Disclosure");
    expect(html).toContain(rendered);
    expect(html.split(leadRule.verbatim_text).length - 1).toBe(1);
  });

  it("does not emit the lead rule for a post-1978 San Francisco property", () => {
    const html = buildLeaseHtml(leaseContext("1 Market St, San Francisco, CA 94105", 1978), SAN_FRANCISCO_LEASE_CONFIG);
    expect(html).not.toContain(leadRule.verbatim_text);
    expect(html).not.toContain("Lead-Based Paint Disclosure");
  });

  it("renders every real lease-signing verbatim rule character-for-character from the catalog", () => {
    const scenarios: Record<string, { jurisdiction: { state: string; city?: string }; fields: Record<string, unknown> }> = {
      "fed-lead-paint": { jurisdiction: { state: "WA", city: "seattle" }, fields: { year_built: 1977 } },
      "ca-megans-law": { jurisdiction: { state: "CA" }, fields: {} },
      "ca-ab1482-notice": { jurisdiction: { state: "CA" }, fields: { ab1482_exempt: false } },
      "sf-rent-ordinance-disclosure": {
        jurisdiction: { state: "CA", city: "san_francisco" },
        fields: { city: "san_francisco", is_rent_ordinance_covered: true },
      },
    };

    for (const rule of disclosureRulesCatalog.rules.filter(
      (candidate) => candidate.lifecycle === "lease_signing" && candidate.verbatim_required,
    )) {
      const scenario = scenarios[rule.id];
      expect(scenario, `Missing scenario for ${rule.id}`).toBeDefined();
      const result = evaluateDisclosureRules(scenario!);
      expect(disclosureVerbatimHtml(result.firedRules)).toContain(rule.verbatim_text!);
    }
  });

  it("keeps California and San Francisco verbatim text intact through final document assembly", () => {
    const california = leaseContext("1 Fremont Blvd, Fremont, CA 94538", 1980);
    california.application = { ...california.application, ab1482Exempt: false } as LeaseGenerationContext["application"];
    const sanFrancisco = leaseContext("1 Market St, San Francisco, CA 94105", 1980);
    sanFrancisco.application = {
      ...sanFrancisco.application,
      isRentOrdinanceCovered: true,
    } as LeaseGenerationContext["application"];
    const megan = disclosureRulesCatalog.rules.find((rule) => rule.id === "ca-megans-law")!;
    const ab1482 = disclosureRulesCatalog.rules.find((rule) => rule.id === "ca-ab1482-notice")!;
    const sfRent = disclosureRulesCatalog.rules.find((rule) => rule.id === "sf-rent-ordinance-disclosure")!;

    const californiaHtml = buildLeaseHtml(california, CALIFORNIA_LEASE_CONFIG);
    const sanFranciscoHtml = buildLeaseHtml(sanFrancisco, SAN_FRANCISCO_LEASE_CONFIG);
    expect(californiaHtml).toContain(megan.verbatim_text!);
    expect(californiaHtml).toContain(ab1482.verbatim_text!);
    expect(sanFranciscoHtml).toContain(sfRent.verbatim_text!);
    expect(sanFranciscoHtml).toContain(`<p data-disclosure-rule="sf-rent-ordinance-disclosure" style="font-size:12pt">${sfRent.verbatim_text}</p>`);
  });

  it("keeps a blank year built as a blocking unknown instead of treating it as post-1978", () => {
    const context = leaseContext("1 Market St, San Francisco, CA 94105");
    const result = evaluateDisclosureRules({
      jurisdiction: { state: "CA", city: "san_francisco" },
      fields: { city: "san_francisco", collects_deposit: true },
    });
    const html = buildLeaseHtml(context, SAN_FRANCISCO_LEASE_CONFIG);

    expect(result.firedRules.map((rule) => rule.id)).not.toContain("fed-lead-paint");
    expect(result.unknownTriggers.some(({ rule, field }) => rule.id === "fed-lead-paint" && field === "year_built")).toBe(true);
    expect(result.unknownUnverifiedTriggers.map(({ field }) => field)).toEqual(
      expect.arrayContaining(["has_periodic_pest_service", "shared_utility_metering"]),
    );
    expect(result.canCompleteLease).toBe(false);
    expect(html).not.toContain("Lease completion required");
    expect(html).not.toContain("Year of construction / first certificate of occupancy");
  });

  it("keeps Fremont statewide and excludes San Francisco-only rules", () => {
    const result = evaluateDisclosureRules({
      jurisdiction: { state: "CA" },
      fields: { city: undefined, year_built: 1980, collects_deposit: false },
    });

    expect(ids(result)).toContain("ca-megans-law");
    expect(ids(result)).not.toContain("sf-coverage-determination");
    expect(ids(result)).not.toContain("sf-rent-ordinance-disclosure");
  });

  it("applies inherited federal, Washington, and Seattle rules only in Seattle", () => {
    const seattle = evaluateDisclosureRules({
      jurisdiction: { state: "WA", city: "seattle" },
      fields: { year_built: 1970, city: "seattle", collects_deposit: true },
    });
    const spokane = evaluateDisclosureRules({
      jurisdiction: { state: "WA" },
      fields: { year_built: 1970, collects_deposit: true },
    });

    expect(seattle.scopes).toEqual(["federal", "washington", "seattle"]);
    expect(ids(seattle)).toEqual(expect.arrayContaining(["fed-lead-paint", "wa-mold", "wa-movein-checklist", "wa-deposit-terms", "seattle-late-fee-cap"]));
    expect(spokane.scopes).toEqual(["federal", "washington"]);
    expect(ids(spokane)).toEqual(expect.arrayContaining(["fed-lead-paint", "wa-mold", "wa-movein-checklist", "wa-deposit-terms"]));
    expect(ids(spokane).some((id) => id.startsWith("seattle-"))).toBe(false);
  });

  it("excludes unverified rules by the single policy and reports their count", () => {
    const result = evaluateDisclosureRules({
      jurisdiction: { state: "WA", city: "seattle" },
      fields: { year_built: 1970, city: "seattle", collects_deposit: true },
    });
    const html = buildLeaseHtml(leaseContext("5259 Brooklyn Ave NE, Seattle, WA 98105", 1970), SEATTLE_LEASE_CONFIG);

    expect(result.triggeredUnverifiedRules.map((rule) => rule.id)).toContain("seattle-renters-handbook");
    expect(ids(result)).not.toContain("seattle-renters-handbook");
    expect(result.excludedUnverifiedRuleCount).toBeGreaterThan(0);
    expect(result.unknownUnverifiedTriggers.map(({ field }) => field)).toContain("has_nonrefundable_fee");
    expect(result.canCompleteLease).toBe(false);
    expect(html).not.toContain("applicable rules are excluded because their citations have not been verified");
  });

  it("leaves the short-term agreement byte-identical when disclosure inputs change", () => {
    const before = leaseContext("5259 Brooklyn Ave NE, Seattle, WA 98105");
    before.application = { ...before.application, rentalType: "short_term", leaseTerm: "Short-Term Stay", leaseEnd: "2026-08-03" };
    before.submission = {
      ...before.submission!,
      shortTermRentalsAllowed: true,
      shortTermDailyCost: "80",
      rooms: [{ ...before.submission!.rooms[0]!, shortTermRent: "80" }],
    };
    const after = { ...before, submission: { ...before.submission!, yearBuilt: 1970 } };

    expect(buildLeaseHtml(after, SEATTLE_LEASE_CONFIG)).toBe(buildLeaseHtml(before, SEATTLE_LEASE_CONFIG));
  });

  it("fires a rule added to a catalog fixture without evaluator code changes", () => {
    const fixture = parseDisclosureRulesCatalog({
      ...disclosureRulesCatalog,
      rules: [
        ...disclosureRulesCatalog.rules,
        {
          id: "fixture-fremont-rule",
          jurisdiction: "california",
          applies_to: [],
          lifecycle: "lease_signing",
          name: "Fixture rule",
          category: "lease_clause",
          trigger: "Fixture value is at least two",
          trigger_logic: { field: "fixture_value", op: ">=", value: 2 },
          statute_cite: "Fixture citation",
          cite_verified: true,
          source_url: "https://example.test/fixture",
          verbatim_required: true,
          verbatim_text: "Fixture catalog text.",
          attachment: null,
          effective_date: null,
          template_section: "Rent",
          notes: "Proves catalog-driven evaluation.",
        },
      ],
    });
    const result = evaluateDisclosureRules({
      jurisdiction: { state: "CA" },
      fields: { fixture_value: 2, year_built: 1980 },
      catalog: fixture,
    });

    expect(ids(result)).toContain("fixture-fremont-rule");
    expect(disclosureVerbatimHtmlForSection(result, "Rent")).toContain("Fixture catalog text.");
  });
});
