/**
 * Lease templates are opt-in, and Delete has to stick.
 *
 * `syncPropertyLeaseTemplatesFromListing` used to create every seeded template
 * on every sync. That is why each property showed the identical four rows
 * (Individual room · Long-term, Individual · Short-term, and two Lease bundle
 * rows) and why Delete appeared broken: removing a row worked, and then the
 * next sync put it straight back. A property with no templates was not a state
 * the model could hold.
 *
 * Sync now only refreshes what a manager already has. Creating is an explicit
 * act. The bundle seeds are gone entirely — a bundle is a pricing arrangement,
 * not a lease format.
 */
import { describe, expect, it } from "vitest";
import {
  addLeaseTemplateFromSeed,
  availableLeaseTemplateSeeds,
  buildLeaseTemplateSeeds,
  syncPropertyLeaseTemplatesFromListing,
} from "@/lib/property-lease-template-sync";
import { readPropertyLeaseTemplates, syncLegacyLeaseFieldsFromTemplates, createPropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

function submission() {
  return createDefaultListingSubmission();
}

describe("default seed catalog", () => {
  it("offers exactly long-term and short-term", () => {
    const seeds = buildLeaseTemplateSeeds(submission());
    expect(seeds.map((s) => s.seedKey).sort()).toEqual(["primary", "short-term"]);
  });

  it("no longer offers the bundle formats", () => {
    const keys = buildLeaseTemplateSeeds(submission()).map((s) => s.seedKey);
    expect(keys).not.toContain("bundle-primary");
    expect(keys).not.toContain("bundle-short-term");
  });
});

describe("syncPropertyLeaseTemplatesFromListing", () => {
  it("leaves a new property with NO templates", () => {
    const synced = syncPropertyLeaseTemplatesFromListing(submission());
    expect(readPropertyLeaseTemplates(synced)).toHaveLength(0);
  });

  it("does not resurrect a deleted template — the Delete bug", () => {
    const added = addLeaseTemplateFromSeed(submission(), "primary");
    expect(readPropertyLeaseTemplates(added)).toHaveLength(1);

    // Simulate the manager deleting it, then anything that triggers a sync.
    const deleted = syncPropertyLeaseTemplatesFromListing(
      addLeaseTemplateFromSeed(submission(), "short-term"),
    );
    expect(
      readPropertyLeaseTemplates(deleted).map((t) => t.listingSeedKey),
    ).toEqual(["short-term"]);

    // Re-syncing must not bring "primary" back.
    const resynced = syncPropertyLeaseTemplatesFromListing(deleted);
    expect(
      readPropertyLeaseTemplates(resynced).map((t) => t.listingSeedKey),
    ).toEqual(["short-term"]);
  });

  it("keeps refreshing a template the manager does have", () => {
    const added = addLeaseTemplateFromSeed(submission(), "primary");
    const synced = syncPropertyLeaseTemplatesFromListing(added);
    const templates = readPropertyLeaseTemplates(synced);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.listingSeedKey).toBe("primary");
  });

  it("preserves a renamed seed template label across sync", () => {
    const added = addLeaseTemplateFromSeed(submission(), "primary");
    const renamed = syncLegacyLeaseFieldsFromTemplates(
      added,
      readPropertyLeaseTemplates(added).map((t) =>
        t.listingSeedKey === "primary" ? { ...t, label: "My custom lease name" } : t,
      ),
    );
    const synced = syncPropertyLeaseTemplatesFromListing(renamed);
    expect(readPropertyLeaseTemplates(synced)[0]?.label).toBe("My custom lease name");
  });

  it("upgrades untouched legacy default labels on sync", () => {
    const legacy = {
      ...createPropertyLeaseTemplate({
        kind: "long-term",
        label: "Individual room · Long-term",
        source: "axis_default",
      }),
      listingSeedKey: "primary" as const,
    };
    const synced = syncPropertyLeaseTemplatesFromListing(
      syncLegacyLeaseFieldsFromTemplates(submission(), [legacy]),
    );
    expect(readPropertyLeaseTemplates(synced)[0]?.label).toBe("Long-term lease");
  });

  it("does not adopt bundle short-term as the primary seed row", () => {
    const bundleShort = {
      ...createPropertyLeaseTemplate({
        kind: "short-term",
        label: "Bundle short",
        source: "axis_default",
      }),
      listingSeedKey: "bundle-short-term" as const,
      customLeaseTerms: "Manager clause",
    };
    const withBundle = syncLegacyLeaseFieldsFromTemplates(submission(), [bundleShort]);
    const synced = syncPropertyLeaseTemplatesFromListing(
      addLeaseTemplateFromSeed(withBundle, "primary"),
    );
    const templates = readPropertyLeaseTemplates(synced);
    const primary = templates.find((t) => t.listingSeedKey === "primary");
    const bundle = templates.find((t) => t.listingSeedKey === "bundle-short-term");
    expect(primary).toBeTruthy();
    expect(primary?.customLeaseTerms?.trim()).not.toBe("Manager clause");
    expect(bundle?.customLeaseTerms).toBe("Manager clause");
  });
});

describe("addLeaseTemplateFromSeed", () => {
  it("adds the chosen default", () => {
    const next = addLeaseTemplateFromSeed(submission(), "primary");
    const templates = readPropertyLeaseTemplates(next);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.kind).toBe("long-term");
  });

  it("refuses a duplicate — two matches for one lease term is ambiguous", () => {
    const once = addLeaseTemplateFromSeed(submission(), "primary");
    const twice = addLeaseTemplateFromSeed(once, "primary");
    expect(readPropertyLeaseTemplates(twice)).toHaveLength(1);
  });

  it("is a no-op for a seed key that is not on offer", () => {
    const next = addLeaseTemplateFromSeed(submission(), "bundle-primary");
    expect(readPropertyLeaseTemplates(next)).toHaveLength(0);
  });
});

describe("availableLeaseTemplateSeeds", () => {
  it("offers both on an empty property", () => {
    expect(availableLeaseTemplateSeeds(submission())).toHaveLength(2);
  });

  it("stops offering one already added, so ADD cannot duplicate", () => {
    const added = addLeaseTemplateFromSeed(submission(), "primary");
    const available = availableLeaseTemplateSeeds(added);
    expect(available.map((s) => s.seedKey)).toEqual(["short-term"]);
  });
});
