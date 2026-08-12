import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  addLeaseTemplateFromSeed,
  buildLeaseTemplateSeeds,
  listLeaseTemplateGenerateChoices,
  resolveLeaseTemplateScenarioForApplication,
  resolvePropertyLeaseTemplateForApplication,
  syncPropertyLeaseTemplatesFromListing,
} from "@/lib/property-lease-template-sync";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { syncPropertyApplicationTemplatesFromListing } from "@/lib/property-application-template-sync";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";

describe("property lease template sync", () => {
  it("offers the long- and short-term defaults, and no bundle formats", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month", "Month-to-Month", "3-Month", "Custom"];
    sub.shortTermRentalsAllowed = true;
    const seeds = buildLeaseTemplateSeeds(sub);
    expect(seeds.map((s) => s.seedKey).sort()).toEqual(["primary", "short-term"]);
    expect(seeds.find((s) => s.seedKey === "primary")?.applicationLeaseTerms?.sort()).toEqual(
      ["12-Month", "Month-to-Month", "3-Month", "Custom"].sort(),
    );
  });

  it("refreshes the templates a manager added, and creates none", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month", "Month-to-Month"];
    expect(readPropertyLeaseTemplates(syncPropertyLeaseTemplatesFromListing(sub))).toHaveLength(0);

    const added = addLeaseTemplateFromSeed(addLeaseTemplateFromSeed(sub, "primary"), "short-term");
    const templates = readPropertyLeaseTemplates(syncPropertyLeaseTemplatesFromListing(added));
    expect(templates.map((t) => t.listingSeedKey).sort()).toEqual(["primary", "short-term"]);
    expect(templates.find((t) => t.listingSeedKey === "primary")?.label).toBe("Long-term lease");
    expect(templates.find((t) => t.listingSeedKey === "primary")?.applicationLeaseTerms).toEqual([
      "12-Month",
      "Month-to-Month",
    ]);
  });

  it("resolves the long-term template for month-to-month applicants", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month", "Month-to-Month"];
    const synced = syncPropertyLeaseTemplatesFromListing(
      addLeaseTemplateFromSeed(addLeaseTemplateFromSeed(sub, "primary"), "short-term"),
    );
    const picked = resolvePropertyLeaseTemplateForApplication(synced, { leaseTerm: "Month-to-Month" });
    expect(picked?.listingSeedKey).toBe("primary");
  });

  it("resolves the long-term template for fixed-term applicants", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month", "Month-to-Month"];
    const synced = syncPropertyLeaseTemplatesFromListing(
      addLeaseTemplateFromSeed(addLeaseTemplateFromSeed(sub, "primary"), "short-term"),
    );
    const picked = resolvePropertyLeaseTemplateForApplication(synced, { leaseTerm: "12-Month" });
    expect(picked?.listingSeedKey).toBe("primary");
    const legacyLabel = resolvePropertyLeaseTemplateForApplication(synced, { leaseTerm: "12 months" });
    expect(legacyLabel?.listingSeedKey).toBe("primary");
  });

  it("resolves short-term template for short-term applicants", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["3-Month", "Month-to-Month", "Custom"];
    sub.shortTermRentalsAllowed = true;
    const synced = syncPropertyLeaseTemplatesFromListing(
      addLeaseTemplateFromSeed(addLeaseTemplateFromSeed(sub, "primary"), "short-term"),
    );
    const short = resolvePropertyLeaseTemplateForApplication(synced, {
      leaseTerm: SHORT_TERM_LEASE_TERM,
      rentalType: "short_term",
    });
    expect(short?.listingSeedKey).toBe("short-term");
    const three = resolvePropertyLeaseTemplateForApplication(synced, { leaseTerm: "3-Month" });
    expect(three?.listingSeedKey).toBe("primary");
    const custom = resolvePropertyLeaseTemplateForApplication(synced, { leaseTerm: "Custom" });
    expect(custom?.listingSeedKey).toBe("primary");
  });

  it("collapses legacy per-term seeds into the long-term default on re-sync", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["3-Month", "Month-to-Month", "Custom"];
    sub.shortTermRentalsAllowed = true;
    sub.propertyLeaseTemplates = [
      {
        id: "lease-tpl-3",
        kind: "long-term",
        label: "3-Month lease",
        listingSeedKey: "fixed-3-month",
        applicationLeaseTerms: ["3-Month"],
        leaseConfigMode: "standard",
        leaseCustomKind: "terms",
        customLeaseTerms: "",
        leaseTemplateDocUrl: null,
        leaseTemplateDocName: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "lease-tpl-st",
        kind: "short-term",
        label: "Short-term stay",
        listingSeedKey: "short-term",
        applicationLeaseTerms: [SHORT_TERM_LEASE_TERM],
        leaseConfigMode: "standard",
        leaseCustomKind: "terms",
        customLeaseTerms: "",
        leaseTemplateDocUrl: null,
        leaseTemplateDocName: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const synced = syncPropertyLeaseTemplatesFromListing(sub);
    const templates = readPropertyLeaseTemplates(synced);
    expect(templates.map((t) => t.listingSeedKey).sort()).toEqual(["primary", "short-term"]);
    expect(templates.find((t) => t.listingSeedKey === "primary")?.applicationLeaseTerms).toEqual([
      "3-Month",
      "Month-to-Month",
      "Custom",
    ]);
  });

  it("keeps a retired bundle template the manager wrote a lease into", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month"];
    sub.propertyLeaseTemplates = [
      {
        id: "lease-tpl-primary",
        kind: "long-term",
        label: "Long-term lease",
        listingSeedKey: "primary",
        applicationLeaseTerms: ["12-Month"],
        leaseConfigMode: "standard",
        leaseCustomKind: "terms",
        customLeaseTerms: "",
        leaseTemplateDocUrl: null,
        leaseTemplateDocName: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "lease-tpl-bundle",
        kind: "long-term",
        label: "Lease bundle · Long-term",
        listingSeedKey: "bundle-primary",
        applicationLeaseTerms: ["12-Month"],
        leaseConfigMode: "custom",
        leaseCustomKind: "terms",
        customLeaseTerms: "Whole-house bundle clauses.",
        leaseTemplateDocUrl: null,
        leaseTemplateDocName: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "lease-tpl-bundle-short",
        kind: "short-term",
        label: "Lease bundle · Short-term",
        listingSeedKey: "bundle-short-term",
        applicationLeaseTerms: [SHORT_TERM_LEASE_TERM],
        leaseConfigMode: "standard",
        leaseCustomKind: "terms",
        customLeaseTerms: "",
        leaseTemplateDocUrl: null,
        leaseTemplateDocName: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const templates = readPropertyLeaseTemplates(syncPropertyLeaseTemplatesFromListing(sub));
    const bundle = templates.find((t) => t.id === "lease-tpl-bundle");
    expect(bundle?.customLeaseTerms).toBe("Whole-house bundle clauses.");
    // The untouched bundle default carries nothing, so it is not resurrected.
    expect(templates.some((t) => t.id === "lease-tpl-bundle-short")).toBe(false);
  });

  it("lists every stored template as a generate choice, best match first", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month"];
    sub.shortTermRentalsAllowed = true;
    const withDefaults = addLeaseTemplateFromSeed(
      addLeaseTemplateFromSeed(sub, "primary"),
      "short-term",
    );

    const shortFirst = listLeaseTemplateGenerateChoices(withDefaults, {
      leaseTerm: SHORT_TERM_LEASE_TERM,
      rentalType: "short_term",
    });
    expect(shortFirst[0]?.scenario).toBe("individual-short");
    expect(shortFirst.every((c) => c.template)).toBe(true);

    // A bundle application has no bundle format to fall back on — it must still
    // land on a selectable choice rather than a greyed-out picker.
    const bundleFirst = listLeaseTemplateGenerateChoices(
      withDefaults,
      { leaseTerm: "12-Month", bundleId: "AXISGRP-test123456" },
      "joint_bundle",
    );
    expect(bundleFirst[0]?.scenario).toBe("individual-long");
  });

  it("offers a manager's own keyless template in the generate picker", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month"];
    sub.propertyLeaseTemplates = [
      {
        id: "lease-tpl-manual",
        kind: "long-term",
        label: "House lease",
        leaseConfigMode: "custom",
        leaseCustomKind: "terms",
        customLeaseTerms: "Manager-authored terms.",
        leaseTemplateDocUrl: null,
        leaseTemplateDocName: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const choices = listLeaseTemplateGenerateChoices(sub, { leaseTerm: "12-Month" });
    expect(choices).toHaveLength(1);
    expect(choices[0]?.template.id).toBe("lease-tpl-manual");
    expect(choices[0]?.label).toBe("House lease");
  });

  it("returns no generate choices for a property with no templates", () => {
    const sub = createDefaultListingSubmission();
    expect(listLeaseTemplateGenerateChoices(sub, { leaseTerm: "12-Month" })).toEqual([]);
  });

  it("preserves manager edits on re-sync", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month"];
    let synced = syncPropertyLeaseTemplatesFromListing(addLeaseTemplateFromSeed(sub, "primary"));
    const templates = readPropertyLeaseTemplates(synced);
    templates[0] = {
      ...templates[0]!,
      customLeaseTerms: "No pets on patio.",
      leaseConfigMode: "custom",
      leaseCustomKind: "terms",
    };
    synced = { ...synced, propertyLeaseTemplates: templates };
    synced = syncPropertyLeaseTemplatesFromListing(synced);
    const again = readPropertyLeaseTemplates(synced).find((t) => t.listingSeedKey === "primary")!;
    expect(again.customLeaseTerms).toBe("No pets on patio.");
    expect(again.leaseConfigMode).toBe("custom");
  });

  it("mirrors lease defaults plus co-signer forms for application templates", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month", "Month-to-Month", "Custom"];
    sub.shortTermRentalsAllowed = true;
    const synced = syncPropertyApplicationTemplatesFromListing(sub);
    const templates = readPropertyApplicationTemplates(synced);
    expect(templates.map((t) => t.listingSeedKey).sort()).toEqual(
      ["cosigner", "cosigner-short-term", "primary", "short-term"].sort(),
    );
    expect(templates.find((t) => t.listingSeedKey === "primary")?.label).toBe("Long-term application");
    expect(templates.find((t) => t.listingSeedKey === "short-term")?.label).toBe("Short-term application");
    expect(templates.find((t) => t.listingSeedKey === "cosigner")?.label).toBe("Long-term co-signer application");
    expect(templates.find((t) => t.listingSeedKey === "cosigner-short-term")?.label).toBe(
      "Short-term co-signer application",
    );
    expect(templates.find((t) => t.listingSeedKey === "cosigner")?.formVariant).toBe("cosigner");
    expect(templates.find((t) => t.listingSeedKey === "cosigner-short-term")?.formVariant).toBe("cosigner");
  });

  it("strips a legacy (optional) suffix from co-signer application labels on re-sync", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month"];
    sub.shortTermRentalsAllowed = true;
    const seeded = syncPropertyApplicationTemplatesFromListing(sub);
    const templates = readPropertyApplicationTemplates(seeded);
    const cosigner = templates.find((t) => t.listingSeedKey === "cosigner")!;
    const withOptional = templates.map((t) =>
      t.id === cosigner.id ? { ...t, label: "Long-term co-signer application (optional)" } : t,
    );
    const resynced = syncPropertyApplicationTemplatesFromListing({
      ...seeded,
      propertyApplicationTemplates: withOptional,
    });
    expect(readPropertyApplicationTemplates(resynced).find((t) => t.listingSeedKey === "cosigner")?.label).toBe(
      "Long-term co-signer application",
    );
  });

  it("resolves lease template scenario from application bundle and term", () => {
    expect(
      resolveLeaseTemplateScenarioForApplication({ leaseTerm: "12-Month", rentalType: "long_term" }),
    ).toBe("individual-long");
    expect(
      resolveLeaseTemplateScenarioForApplication({
        leaseTerm: SHORT_TERM_LEASE_TERM,
        rentalType: "short_term",
      }),
    ).toBe("individual-short");
    expect(
      resolveLeaseTemplateScenarioForApplication({
        leaseTerm: "12-Month",
        bundleId: "AXISGRP-test123456",
      }),
    ).toBe("bundle-long");
    expect(
      resolveLeaseTemplateScenarioForApplication({
        leaseTerm: "12-Month",
        applyingAsGroup: "yes",
        groupId: "AXISGRP-test123456",
      } as Parameters<typeof resolveLeaseTemplateScenarioForApplication>[0]),
    ).toBe("individual-long");
    expect(
      resolveLeaseTemplateScenarioForApplication(
        { leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" },
        "joint_bundle",
      ),
    ).toBe("bundle-short");
  });
});
