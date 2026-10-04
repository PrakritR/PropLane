// Long term / Short term sections (plan "mobile-step-tabs-1004", Part 2).
//
//  - Basics "Stays you offer" writes the EXISTING allowedLeaseTerms + shortTermRentalsAllowed;
//  - an application's `appliesTo` is derived for rows saved before it existed;
//  - an explicit default application per stay routes the applicant, and a listing with none routes as before;
//  - Pricing draws one independent section per stay offered, never a Both.
import { describe, expect, it } from "vitest";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
} from "@/lib/manager-listing-submission";
import { listingOfferedStays, staysPatch, visibleStaySections } from "@/lib/listing-stays";
import {
  applicationAppliesTo,
  createPropertyApplicationTemplate,
  effectiveDefaultApplicationForStay,
  explicitDefaultApplicationForStay,
  readPropertyApplicationTemplates,
  syncLegacyApplicationFieldsFromTemplates,
  withApplicationAppliesTo,
  withApplicationDefaultForStay,
  withoutApplicationDefaultForStay,
  type ApplicationTemplateQuestionConfig,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { applicationPinForStayTerm } from "@/lib/property-form-stay-type-routing";
import { applicationForAppliesTo, defaultLeaseIdForApplication } from "@/lib/leasing-quick-add";
import { syncPropertyApplicationTemplatesFromListing } from "@/lib/property-application-template-sync";
import { pricingSectionOptions } from "@/lib/pricing-lease-options";

const published = {
  version: 3,
  disabledStandardApplicationKeys: [],
  customApplicationFields: [],
  applicationConfigMode: "standard",
} as unknown as ApplicationTemplateQuestionConfig;

const lease = (label: string, kind: "long-term" | "short-term", terms: string[], seed?: PropertyLeaseTemplate["listingSeedKey"]) =>
  ({ ...createPropertyLeaseTemplate({ kind, label, source: "axis_default" }), applicationLeaseTerms: terms, listingSeedKey: seed }) as PropertyLeaseTemplate;

const form = (label: string, kind: "long-term" | "short-term", extra: Partial<PropertyApplicationTemplate> = {}) =>
  ({ ...createPropertyApplicationTemplate({ kind, label }), publishedQuestionConfig: published, ...extra }) as PropertyApplicationTemplate;

describe("Basics: Stays you offer writes the existing lease-term fields", () => {
  const base = () => createDefaultListingSubmission();

  it("a listing that never stated a choice offers Long term alone", () => {
    expect(listingOfferedStays(base())).toEqual({ long_term: true, short_term: false });
    expect(visibleStaySections(base())).toEqual(["long_term", "both"]);
  });

  it("turning Short term on writes allowedLeaseTerms and shortTermRentalsAllowed (and keeps Long-term)", () => {
    const sub = base();
    const patch = staysPatch(sub, { long_term: true, short_term: true })!;
    expect(patch.shortTermRentalsAllowed).toBe(true);
    expect(patch.allowedLeaseTerms).toEqual(["Long-term", "Short-Term Stay"]);
    expect(resolveAllowedLeaseTerms({ ...sub, ...patch })).toEqual(["Long-term", "Short-Term Stay"]);
    expect(visibleStaySections({ ...sub, ...patch })).toEqual(["long_term", "short_term", "both"]);
  });

  it("Short term alone drops the long-term kinds; Long term alone drops Short term", () => {
    const both = { ...base(), ...staysPatch(base(), { long_term: true, short_term: true })! };
    const shortOnly = staysPatch(both, { long_term: false, short_term: true })!;
    expect(shortOnly.allowedLeaseTerms).toEqual(["Short-Term Stay"]);
    expect(listingOfferedStays({ ...both, ...shortOnly })).toEqual({ long_term: false, short_term: true });
    const longOnly = staysPatch({ ...both, ...shortOnly }, { long_term: true, short_term: false })!;
    expect(longOnly.shortTermRentalsAllowed).toBe(false);
    expect(longOnly.allowedLeaseTerms).toEqual(["Long-term"]);
  });

  it("the last stay cannot be turned off", () => {
    expect(staysPatch(base(), { long_term: false, short_term: false })).toBeNull();
  });

  it("keeps Month-to-month and Custom while Long term stays on", () => {
    const sub = { ...base(), allowedLeaseTerms: ["Long-term", "Month-to-Month"] };
    const patch = staysPatch(sub, { long_term: true, short_term: true })!;
    expect(patch.allowedLeaseTerms).toEqual(["Long-term", "Month-to-Month", "Short-Term Stay"]);
  });

  it("an explicit shortTermRentalsAllowed:false is never switched back on by a short-term application", () => {
    const sub = { ...base(), shortTermRentalsAllowed: false };
    const short = form("Short-term application", "short-term", { formVariant: "short_term" });
    expect(syncLegacyApplicationFieldsFromTemplates(sub, [short]).shortTermRentalsAllowed).toBe(false);
    // A listing that never stated it still reads a short-term application as short-term stays.
    const unset = { ...base(), shortTermRentalsAllowed: undefined };
    expect(syncLegacyApplicationFieldsFromTemplates(unset, [short]).shortTermRentalsAllowed).toBe(true);
  });
});

describe("saving an application never changes the stays on offer", () => {
  it("the seeded short-term form does not switch Short term on for a long-term listing", () => {
    const longOnly = { ...createDefaultListingSubmission(), shortTermRentalsAllowed: false };
    const synced = syncPropertyApplicationTemplatesFromListing(longOnly);
    expect(synced.shortTermRentalsAllowed).toBe(false);
    expect(listingOfferedStays(synced)).toEqual({ long_term: true, short_term: false });
  });

  it("a listing that never stated its stays keeps Long term when a short-term form turns Short term on", () => {
    const unset = { ...createDefaultListingSubmission(), shortTermRentalsAllowed: undefined, allowedLeaseTerms: [] };
    const next = syncLegacyApplicationFieldsFromTemplates(unset, [form("Short-term application", "short-term", { formVariant: "short_term" })]);
    expect(listingOfferedStays(next)).toEqual({ long_term: true, short_term: true });
  });
});

describe("appliesTo is derived for rows saved before it existed", () => {
  const longLease = lease("Long-term lease", "long-term", ["Long-term"], "primary");
  const shortLease = lease("Short-term lease", "short-term", ["Short-Term Stay"], "short-term");
  const leases = [longLease, shortLease];

  it("a linked short-term lease makes a short-term application; any other lease makes a long-term one", () => {
    expect(applicationAppliesTo(form("A", "long-term", { linkedLeaseTemplateId: shortLease.id }), leases)).toBe("short_term");
    expect(applicationAppliesTo(form("B", "short-term", { linkedLeaseTemplateId: longLease.id }), leases)).toBe("long_term");
    expect(applicationAppliesTo(form("C", "long-term", { linkedLeaseTemplateId: longLease.id }), leases)).toBe("long_term");
  });

  it("with no lease link it follows the form's own variant", () => {
    expect(applicationAppliesTo(form("A", "short-term", { formVariant: "short_term" }), leases)).toBe("short_term");
    expect(applicationAppliesTo(form("B", "long-term"), leases)).toBe("long_term");
  });

  it("a co-signer application is for both", () => {
    expect(applicationAppliesTo(form("Co-signer application", "long-term", { formVariant: "cosigner" }), leases)).toBe("both");
    expect(applicationAppliesTo(form("Co-signer", "short-term", { listingSeedKey: "cosigner-short-term" }), leases)).toBe("both");
  });

  it("an explicit appliesTo wins over everything derived", () => {
    expect(applicationAppliesTo(form("A", "long-term", { linkedLeaseTemplateId: longLease.id, appliesTo: "both" }), leases)).toBe("both");
  });

  it("survives a read of the stored listing (no migration), and an invalid stored value is dropped", () => {
    const stored = [
      form("Keep", "long-term", { appliesTo: "short_term", defaultFor: ["short_term"] }),
      form("Junk", "long-term", { appliesTo: "nonsense" as never, defaultFor: ["nope"] as never }),
    ];
    const read = readPropertyApplicationTemplates({ propertyApplicationTemplates: stored });
    expect(read[0]!.appliesTo).toBe("short_term");
    expect(read[0]!.defaultFor).toEqual(["short_term"]);
    expect(read[1]!.appliesTo).toBeUndefined();
    expect(read[1]!.defaultFor).toBeUndefined();
  });
});

describe("the default application of a stay", () => {
  const a = form("Long A", "long-term");
  const b = form("Long B", "long-term");
  const s = form("Short S", "short-term", { formVariant: "short_term" });

  it("with no explicit default the first published application of the stay is the displayed default", () => {
    expect(explicitDefaultApplicationForStay([a, b, s], "long_term")).toBeNull();
    expect(effectiveDefaultApplicationForStay([a, b, s], "long_term")?.id).toBe(a.id);
    expect(effectiveDefaultApplicationForStay([a, b, s], "short_term")?.id).toBe(s.id);
  });

  it("setting a default moves it, one per stay, and keeps the other stay's default", () => {
    const first = withApplicationDefaultForStay([a, b, s], s.id, "short_term");
    const next = withApplicationDefaultForStay(first, b.id, "long_term");
    expect(next.find((row) => row.defaultFor?.includes("long_term"))!.id).toBe(b.id);
    expect(next.find((row) => row.defaultFor?.includes("short_term"))!.id).toBe(s.id);
    const moved = withApplicationDefaultForStay(next, a.id, "long_term");
    expect(moved.filter((row) => row.defaultFor?.includes("long_term")).map((row) => row.id)).toEqual([a.id]);
  });

  it("turning a default off clears only that application's default for that stay", () => {
    const set = withApplicationDefaultForStay(withApplicationDefaultForStay([a, b, s], a.id, "long_term"), s.id, "short_term");
    const cleared = withoutApplicationDefaultForStay(set, a.id, "long_term");
    expect(cleared.find((row) => row.id === a.id)!.defaultFor).toBeUndefined();
    expect(cleared.find((row) => row.id === s.id)!.defaultFor).toEqual(["short_term"]);
    // Clearing a default the row does not hold changes nothing.
    expect(withoutApplicationDefaultForStay(set, b.id, "long_term").map((row) => row.defaultFor)).toEqual(set.map((row) => row.defaultFor));
  });

  it("moving an application to another section drops a default it can no longer hold", () => {
    const withDefault = withApplicationDefaultForStay([a, b, s], a.id, "long_term");
    const moved = withApplicationAppliesTo(withDefault, a.id, "short_term");
    expect(moved.find((row) => row.id === a.id)!.appliesTo).toBe("short_term");
    expect(moved.find((row) => row.id === a.id)!.defaultFor).toBeUndefined();
  });
});

describe("routing: the applicant picks a stay and gets that stay's default application", () => {
  const longLease = lease("Long-term lease", "long-term", ["Long-term"], "primary");
  const mtmLease = lease("Month-to-month lease", "long-term", ["Month-to-Month"]);
  const shortLease = lease("Short-term lease", "short-term", ["Short-Term Stay"], "short-term");
  const longForm = form("Long A", "long-term", { linkedLeaseTemplateId: longLease.id });
  const otherLong = form("Long B", "long-term", { linkedLeaseTemplateId: mtmLease.id });
  const shortForm = form("Short S", "short-term", { formVariant: "short_term", linkedLeaseTemplateId: shortLease.id });
  const otherShort = form("Short T", "short-term", { formVariant: "short_term" });
  const build = (templates: PropertyApplicationTemplate[]) =>
    normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      propertyLeaseTemplates: [longLease, mtmLease, shortLease],
      propertyApplicationTemplates: templates,
    });

  it("a listing with no explicit default routes exactly as before (the lease-mapped form)", () => {
    const sub = build([longForm, otherLong, shortForm, otherShort]);
    expect(applicationPinForStayTerm(sub, "Long-term")?.templateId).toBe(longForm.id);
    expect(applicationPinForStayTerm(sub, "Month-to-Month")?.templateId).toBe(otherLong.id);
    expect(applicationPinForStayTerm(sub, "Short-Term Stay")?.templateId).toBe(shortForm.id);
    expect(applicationPinForStayTerm(sub, "Custom")).toBeNull();
    expect(applicationPinForStayTerm(sub, "")).toBeNull();
    // Even with a stay hint, no explicit default changes nothing.
    expect(applicationPinForStayTerm(sub, "", "short_term")).toBeNull();
  });

  it("an explicit default wins for its stay, with the published version", () => {
    const sub = build(withApplicationDefaultForStay(withApplicationDefaultForStay([longForm, otherLong, shortForm, otherShort], otherLong.id, "long_term"), otherShort.id, "short_term"));
    expect(applicationPinForStayTerm(sub, "Long-term")).toEqual({ templateId: otherLong.id, templateVersion: 3 });
    expect(applicationPinForStayTerm(sub, "Month-to-Month")?.templateId).toBe(otherLong.id);
    expect(applicationPinForStayTerm(sub, "Short-Term Stay")).toEqual({ templateId: otherShort.id, templateVersion: 3 });
  });

  it("the stay can come from the wizard's rental type before a lease term is picked", () => {
    const sub = build(withApplicationDefaultForStay([longForm, otherLong, shortForm, otherShort], otherShort.id, "short_term"));
    expect(applicationPinForStayTerm(sub, "", "short_term")?.templateId).toBe(otherShort.id);
    // Long term has no explicit default, so it is unchanged.
    expect(applicationPinForStayTerm(sub, "", "long_term")).toBeNull();
    expect(applicationPinForStayTerm(sub, "Long-term", "long_term")?.templateId).toBe(longForm.id);
  });

  it("an unpublished or not-needed default is never pinned; routing falls back to today's", () => {
    const draftDefault = { ...otherLong, publishedQuestionConfig: undefined };
    const sub = build(withApplicationDefaultForStay([longForm, draftDefault, shortForm], draftDefault.id, "long_term"));
    expect(applicationPinForStayTerm(sub, "Long-term")?.templateId).toBe(longForm.id);
    const off = build(withApplicationDefaultForStay([longForm, { ...otherLong, offered: false }, shortForm], otherLong.id, "long_term"));
    expect(applicationPinForStayTerm(off, "Long-term")?.templateId).toBe(longForm.id);
  });
});

describe("a new application asks Applies to first and its links default from it", () => {
  const longLease = lease("Long-term lease", "long-term", ["Long-term"], "primary");
  const shortLease = lease("Short-term lease", "short-term", ["Short-Term Stay"], "short-term");
  const cosigner = form("Co-signer application", "long-term", { formVariant: "cosigner" });
  const catalog = { applications: [cosigner], leases: [longLease, shortLease] };
  const fresh = () => createPropertyApplicationTemplate({ kind: "long-term", label: "New application" });

  it("Short term: the short-term form and lease", () => {
    const made = applicationForAppliesTo(fresh(), "short_term", catalog);
    expect(made.appliesTo).toBe("short_term");
    expect(made.formVariant).toBe("short_term");
    expect(made.linkedLeaseTemplateId).toBe(shortLease.id);
    expect(made.linkedCosignerApplicationTemplateId).toBe(cosigner.id);
  });

  it("Long term: the standard form and the long-term lease", () => {
    const made = applicationForAppliesTo(fresh(), "long_term", catalog);
    expect(made.formVariant).toBe("standard");
    expect(made.linkedLeaseTemplateId).toBe(longLease.id);
  });

  it("Both: the standard form with no lease of its own", () => {
    const made = applicationForAppliesTo(fresh(), "both", catalog);
    expect(made.appliesTo).toBe("both");
    expect(made.linkedLeaseTemplateId ?? null).toBeNull();
    expect(defaultLeaseIdForApplication({ ...fresh(), appliesTo: "both" }, catalog.leases)).toBeNull();
  });

  it("without appliesTo the lease default is today's (by the form's own variant)", () => {
    expect(defaultLeaseIdForApplication(fresh(), catalog.leases)).toBe(longLease.id);
    expect(defaultLeaseIdForApplication({ ...fresh(), kind: "short-term", formVariant: "short_term" }, catalog.leases)).toBe(shortLease.id);
  });
});

describe("Pricing draws one independent section per stay offered, never a Both", () => {
  const base = createDefaultListingSubmission();
  const withStays = (long: boolean, short: boolean) => ({ ...base, ...staysPatch(base, { long_term: long, short_term: short })! });

  it("Long term and Short term when both are offered", () => {
    expect(pricingSectionOptions(withStays(true, true)).map((option) => option.label)).toEqual(["Long-term", "Short-term"]);
  });

  it("only ever two sections: month-to-month, custom and Airbnb fold into their stay, never a section of their own", () => {
    const rich = {
      ...withStays(true, true),
      allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay", "Airbnb Stay"],
      airbnbRentalsAllowed: true,
    };
    expect(pricingSectionOptions(rich as never).map((option) => option.label)).toEqual(["Long-term", "Short-term"]);
    const longOnly = { ...withStays(true, false), allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom"] };
    expect(pricingSectionOptions(longOnly as never).map((option) => option.label)).toEqual(["Long-term"]);
  });

  it("only the stays the listing offers, even when a short-term lease is stored", () => {
    const seeded = { ...withStays(true, false), propertyLeaseTemplates: [lease("Short-term lease", "short-term", ["Short-Term Stay"], "short-term")] };
    expect(pricingSectionOptions(seeded).map((option) => option.label)).toEqual(["Long-term"]);
    expect(pricingSectionOptions(withStays(false, true)).map((option) => option.label)).toEqual(["Short-term"]);
  });
});
