/**
 * Deleting an application sets `propertyApplicationTemplatesExplicit`, which
 * permanently stops auto-seeding — that is what makes Delete stick. Without a
 * way to add a PropLane default back, that is a ONE-WAY door: the manager can
 * never recover the application they removed.
 *
 * These cases pin the way back, and pin that taking it does not quietly undo
 * the other deletions.
 */
import { describe, expect, it } from "vitest";
import {
  addApplicationTemplateFromSeed,
  availableApplicationTemplateSeeds,
  syncPropertyApplicationTemplatesFromListing,
} from "@/lib/property-application-template-sync";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

function baseSubmission() {
  const sub = createDefaultListingSubmission();
  return normalizeManagerListingSubmissionV1(sub);
}

/** A property whose manager deleted every application — the opt-in end state. */
function emptiedSubmission() {
  return {
    ...baseSubmission(),
    propertyApplicationTemplates: [],
    propertyApplicationTemplatesExplicit: true as const,
  };
}

describe("PropLane default applications can be added back", () => {
  it("offers nothing while the property still carries the auto-seeded defaults", () => {
    const seeded = syncPropertyApplicationTemplatesFromListing(baseSubmission());
    expect(readPropertyApplicationTemplates(seeded).length).toBeGreaterThan(0);
    expect(availableApplicationTemplateSeeds(seeded)).toEqual([]);
  });

  it("offers every default once the manager has deleted them all", () => {
    const offers = availableApplicationTemplateSeeds(emptiedSubmission());
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((seed) => seed.label.trim().length > 0)).toBe(true);
  });

  it("adds exactly the chosen default and leaves the rest deleted", () => {
    const emptied = emptiedSubmission();
    const offers = availableApplicationTemplateSeeds(emptied);
    const chosen = offers[0]!;

    const next = addApplicationTemplateFromSeed(emptied, chosen.seedKey);
    const rows = readPropertyApplicationTemplates(next);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.listingSeedKey).toBe(chosen.seedKey);
    // Still explicit — adding one back by hand is curation, not a request to
    // resume auto-seeding every other default the manager deleted.
    expect(next.propertyApplicationTemplatesExplicit).toBe(true);
    expect(readPropertyApplicationTemplates(syncPropertyApplicationTemplatesFromListing(next))).toHaveLength(1);
  });

  it("refuses to add the same default twice", () => {
    const emptied = emptiedSubmission();
    const chosen = availableApplicationTemplateSeeds(emptied)[0]!;
    const once = addApplicationTemplateFromSeed(emptied, chosen.seedKey);
    const twice = addApplicationTemplateFromSeed(once, chosen.seedKey);

    // Identity, not just length: two rows on one seed key would give the
    // applicant-form router two equally valid matches for one lease term.
    expect(twice).toBe(once);
    expect(readPropertyApplicationTemplates(twice)).toHaveLength(1);
  });

  it("stops offering a default once it is back on the property", () => {
    const emptied = emptiedSubmission();
    const chosen = availableApplicationTemplateSeeds(emptied)[0]!;
    const next = addApplicationTemplateFromSeed(emptied, chosen.seedKey);
    expect(availableApplicationTemplateSeeds(next).map((s) => s.seedKey)).not.toContain(chosen.seedKey);
  });
});
