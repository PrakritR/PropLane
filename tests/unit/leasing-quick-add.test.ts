/**
 * One pattern for applications, leases and move-in forms: the "Quick add" helper (which PropLane defaults are
 * missing, and adding one), and the starting setup of a brand-new property.
 */
import { describe, expect, it } from "vitest";
import { leaseIdForApplication } from "@/lib/application-lease-mapping";
import {
  applicationWithDefaultLinks,
  defaultLeaseIdForApplication,
  missingApplicationDefaults,
  missingLeaseDefaults,
  missingMoveInStarters,
  submissionWithApplicationDefault,
  submissionWithDefaultLeasingSetup,
  submissionWithLeaseDefault,
  submissionWithMoveInStarter,
} from "@/lib/leasing-quick-add";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { MOVE_IN_FORM_STARTERS, normalizeMoveInFormTemplates, readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import { removePropertyApplicationTemplate, readPropertyApplicationTemplates, withPropertyApplicationTemplatesExplicit } from "@/lib/property-application-templates";
import { removePropertyLeaseTemplate, readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { submissionAfterRemovingApplicationTemplate } from "@/lib/property-application-template-sync";
import { syncLegacyLeaseFieldsFromTemplates } from "@/lib/property-lease-templates";
import { pricingLeaseOptions } from "@/lib/pricing-lease-options";

const fresh = () => createDefaultListingSubmission();
/** A property whose applications are not auto-seeded (the manager owns the list), so every default is missing. */
const bare = () => withPropertyApplicationTemplatesExplicit(createDefaultListingSubmission(), []);
const labels = (entries: { label: string }[]) => entries.map((entry) => entry.label);

describe("a new property's default setup", () => {
  it("Long-term application -> Long-term lease, Short-term application -> Short-term lease, Co-signer application -> no lease", () => {
    const sub = submissionWithDefaultLeasingSetup(fresh());
    const apps = readPropertyApplicationTemplates(sub);
    const leases = readPropertyLeaseTemplates(sub);
    expect(apps.map((a) => a.label)).toEqual(["Long-term application", "Short-term application", "Co-signer application"]);
    expect(leases.map((l) => l.label)).toEqual(["Long-term lease", "Short-term lease"]);
    const catalog = { applications: apps, leases };
    const leaseOf = (seed: string) => leases.find((l) => l.id === leaseIdForApplication(catalog, apps.find((a) => a.listingSeedKey === seed)!.id))?.label;
    expect(leaseOf("primary")).toBe("Long-term lease");
    expect(leaseOf("short-term")).toBe("Short-term lease");
    const cosigner = apps.find((a) => a.listingSeedKey === "cosigner")!;
    expect(leaseIdForApplication(catalog, cosigner.id)).toBeNull();
    // The long-term application uses PropLane's Co-signer application as its co-signer form. Co-signer is long
    // term only, so the short-term application has none.
    expect(apps.find((a) => a.listingSeedKey === "primary")!.linkedCosignerApplicationTemplateId).toBe(cosigner.id);
    expect(apps.find((a) => a.listingSeedKey === "short-term")!.linkedCosignerApplicationTemplateId ?? null).toBeNull();
  });

  it("stores a Move-in checklist that goes to every lease type", () => {
    const forms = readMoveInFormTemplates(submissionWithDefaultLeasingSetup(fresh()));
    expect(forms.map((f) => f.name)).toEqual(["Move-in checklist"]);
    expect(forms[0]!.leaseType ?? "all").toBe("all");
    expect(forms[0]!.linkedLeaseTemplateIds).toEqual([]);
  });

  it("leaves a property that already has any application, lease or move-in form exactly as it is", () => {
    const existing = submissionWithMoveInStarter(fresh(), "key-receipt");
    expect(submissionWithDefaultLeasingSetup(existing)).toBe(existing);
    const withLease = submissionWithLeaseDefault(fresh(), "primary");
    expect(submissionWithDefaultLeasingSetup(withLease)).toBe(withLease);
  });

  it("a new application starts linked to the default lease of its type", () => {
    const sub = submissionWithDefaultLeasingSetup(fresh());
    const apps = readPropertyApplicationTemplates(sub);
    const leases = readPropertyLeaseTemplates(sub);
    const standard = { kind: "long-term" as const, formVariant: "standard" as const };
    expect(defaultLeaseIdForApplication(standard, leases)).toBe(leases.find((l) => l.listingSeedKey === "primary")!.id);
    expect(defaultLeaseIdForApplication({ kind: "short-term", formVariant: "short_term" }, leases)).toBe(leases.find((l) => l.listingSeedKey === "short-term")!.id);
    expect(defaultLeaseIdForApplication({ kind: "long-term", formVariant: "cosigner" }, leases)).toBeNull();
    const created = applicationWithDefaultLinks({ ...apps[0]!, id: "new", linkedLeaseTemplateId: undefined, linkedCosignerApplicationTemplateId: undefined }, { applications: apps, leases });
    expect(created.linkedLeaseTemplateId).toBe(leases.find((l) => l.listingSeedKey === "primary")!.id);
    expect(created.linkedCosignerApplicationTemplateId).toBe(apps.find((a) => a.listingSeedKey === "cosigner")!.id);
  });
});

describe("Quick add: which PropLane defaults are missing", () => {
  it("lists the applications, leases and move-in starters a property does not carry, and nothing it does", () => {
    const empty = bare();
    expect(labels(missingApplicationDefaults(empty))).toEqual(["Long-term application", "Short-term application", "Co-signer application"]);
    expect(labels(missingLeaseDefaults(empty))).toEqual(["Long-term lease", "Short-term lease"]);
    expect(labels(missingMoveInStarters(empty))).toEqual(MOVE_IN_FORM_STARTERS.filter((s) => s.starterKey).map((s) => s.name));
    const set = submissionWithDefaultLeasingSetup(fresh());
    expect(missingApplicationDefaults(set)).toEqual([]);
    expect(missingLeaseDefaults(set)).toEqual([]);
    expect(labels(missingMoveInStarters(set))).not.toContain("Move-in checklist");
  });

  it("deleting a PropLane default puts it back in Quick add, and one click re-adds it (linked to its lease)", () => {
    const set = submissionWithDefaultLeasingSetup(fresh());
    const apps = readPropertyApplicationTemplates(set);
    const withoutShort = submissionAfterRemovingApplicationTemplate(set, removePropertyApplicationTemplate(apps, apps.find((a) => a.listingSeedKey === "short-term")!.id));
    expect(labels(missingApplicationDefaults(withoutShort))).toEqual(["Short-term application"]);
    const back = submissionWithApplicationDefault(withoutShort, "short-term");
    expect(missingApplicationDefaults(back)).toEqual([]);
    const restored = readPropertyApplicationTemplates(back).find((a) => a.listingSeedKey === "short-term")!;
    const leases = readPropertyLeaseTemplates(back);
    expect(restored.linkedLeaseTemplateId).toBe(leases.find((l) => l.listingSeedKey === "short-term")!.id);
  });

  it("re-adding a deleted default lease relinks the applications of its type", () => {
    const set = submissionWithDefaultLeasingSetup(fresh());
    const leases = readPropertyLeaseTemplates(set);
    const shortId = leases.find((l) => l.listingSeedKey === "short-term")!.id;
    const kept = removePropertyLeaseTemplate(leases, shortId);
    const withoutShortLease = syncLegacyLeaseFieldsFromTemplates(set, kept);
    expect(labels(missingLeaseDefaults(withoutShortLease))).toEqual(["Short-term lease"]);
    const back = submissionWithLeaseDefault(withoutShortLease, "short-term");
    const newLease = readPropertyLeaseTemplates(back).find((l) => l.listingSeedKey === "short-term")!;
    const shortApp = readPropertyApplicationTemplates(back).find((a) => a.listingSeedKey === "short-term")!;
    expect(shortApp.linkedLeaseTemplateId).toBe(newLease.id);
    expect(missingLeaseDefaults(back)).toEqual([]);
  });

  it("Quick add adds to the tab you are on: a stay only offers the defaults that tab would then list", () => {
    const airbnbSub = withPropertyApplicationTemplatesExplicit(
      { ...createDefaultListingSubmission(), airbnbRentalsAllowed: true },
      [],
    );
    // The Airbnb starter is a short-stay lease, so it belongs to the Short term tab, never Long term.
    expect(labels(missingLeaseDefaults(airbnbSub, "long_term"))).toEqual(["Long-term lease"]);
    expect(labels(missingLeaseDefaults(airbnbSub, "short_term"))).toEqual(["Short-term lease", "Airbnb stay agreement"]);
    // Co-signer applications live under Long term only.
    expect(labels(missingApplicationDefaults(airbnbSub, "long_term"))).toEqual([
      "Long-term application",
      "Co-signer application",
    ]);
    expect(labels(missingApplicationDefaults(airbnbSub, "short_term"))).toEqual([
      "Short-term application",
      "Short-term application",
    ]);
  });

  it("a move-in starter is added as the manager's own form that sends only by hand", () => {
    const added = readMoveInFormTemplates(submissionWithMoveInStarter(fresh(), "key-receipt"));
    expect(added).toHaveLength(1);
    expect(added[0]!.starterKey).toBe("key-receipt");
    expect(added[0]!.trigger).toBe("manual");
    // Adding it twice does nothing.
    const twice = submissionWithMoveInStarter(submissionWithMoveInStarter(fresh(), "key-receipt"), "key-receipt");
    expect(readMoveInFormTemplates(twice)).toHaveLength(1);
  });
});

describe("a move-in form's Lease type", () => {
  const base = readMoveInFormTemplates(submissionWithMoveInStarter(fresh(), "key-receipt"))[0]!;
  it("defaults to All and only a Long-term or Short-term restriction is stored", () => {
    expect(base.leaseType).toBeUndefined();
    const [short] = normalizeMoveInFormTemplates([{ ...base, leaseType: "short-term" }]);
    expect(short!.leaseType).toBe("short-term");
    const [junk] = normalizeMoveInFormTemplates([{ ...base, leaseType: "everything" }]);
    expect(junk!.leaseType).toBeUndefined();
    const [all] = normalizeMoveInFormTemplates([{ ...base, leaseType: "all" }]);
    expect(all!.leaseType).toBeUndefined();
  });
});

describe("the leasing options a property is priced under", () => {
  const lease = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
    id, kind: "long-term", label, leaseConfigMode: "standard", leaseCustomKind: "terms", customLeaseTerms: "",
    leaseTemplateDocUrl: null, leaseTemplateDocName: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...extra,
  });
  it("is Long-term alone for a property that offers nothing else", () => {
    expect(pricingLeaseOptions(fresh()).map((o) => o.label)).toEqual(["Long-term"]);
  });
  it("adds Short-term when stays are offered, and Month-to-month only when a lease allows it", () => {
    const stays = { ...fresh(), shortTermRentalsAllowed: true, allowedLeaseTerms: ["Long-term", "Short-Term Stay"] };
    expect(pricingLeaseOptions(stays).map((o) => o.label)).toEqual(["Long-term", "Short-term"]);
    const m2m = {
      ...stays,
      allowedLeaseTerms: ["Long-term", "Short-Term Stay", "Month-to-Month"],
      propertyLeaseTemplates: [lease("l1", "Long-term lease", { listingSeedKey: "primary", applicationLeaseTerms: ["Long-term", "Month-to-Month"] })],
    };
    expect(pricingLeaseOptions(m2m as never).map((o) => o.label)).toEqual(["Long-term", "Short-term", "Month-to-month"]);
    // Custom dates are an option of the long-term lease, never a tab of their own.
    const custom = { ...stays, allowedLeaseTerms: ["Long-term", "Short-Term Stay", "Custom"] };
    expect(pricingLeaseOptions(custom as never).map((o) => o.label)).toEqual(["Long-term", "Short-term"]);
  });
  it("lists a custom lease by name when it routes a lease type of its own", () => {
    const sub = {
      ...fresh(),
      propertyLeaseTemplates: [lease("l9", "Lake house stays", { kind: "custom", applicationLeaseTerms: ["Airbnb"] })],
    };
    expect(pricingLeaseOptions(sub as never).map((o) => o.label)).toEqual(["Long-term", "Lake house stays"]);
  });
});
