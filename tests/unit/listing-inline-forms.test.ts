import { describe, expect, it } from "vitest";
import {
  applicationsOfLease,
  applicationFeeScopeForTemplate,
  createInlineApplication,
  duplicateLeaseTemplate,
  leaseOfApplication,
  linkApplicationToLease,
  publishPendingApplicationDrafts,
  readApplicationFeeInput,
  releaseDeletedLeaseLinks,
  setApplicationsOfLease,
  uniqueFormLabel,
  withApplicationFee,
  withQuestionSlice,
  questionSliceForTemplate,
} from "@/lib/listing-inline-forms";
import { longTermPrivateArrangementRow, placementFeeOptionsFor, resolvePlacementStandardFees } from "@/lib/listing-placement-standard-fees";
import { createDefaultListingSubmission, resolveAllowedLeaseTerms, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  createPropertyApplicationTemplate,
  isApplicationTemplateOffered,
  publishedApplicationTemplateForApplicant,
  readPropertyApplicationTemplates,
  withPropertyApplicationTemplatesExplicit,
} from "@/lib/property-application-templates";
import { submissionWithLeaseOption, submissionWithLeaseTemplates } from "@/lib/property-form-stay-type-routing";
import { createPropertyLeaseTemplate, readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { syncPropertyLeaseTemplatesFromListing, addLeaseTemplateFromSeed } from "@/lib/property-lease-template-sync";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { termFeeText } from "@/lib/room-term-fees";

function twoRooms(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const room = base.rooms[0]!;
  return { ...base, rooms: [{ ...room, id: "r1", name: "Room 1", monthlyRent: 900 }, { ...room, id: "r2", name: "Room 2", monthlyRent: 1000 }] };
}

const fee = (sub: ManagerListingSubmissionV1, roomId: string, input: Parameters<typeof placementFeeOptionsFor>[1]) =>
  resolvePlacementStandardFees(sub, placementFeeOptionsFor(sub, { ...input, room: sub.rooms.find((r) => r.id === roomId) })).applicationFee;

describe("application fee: one source", () => {
  it("typing a long-term fee writes every room's own fee, which the resolver and the Pricing box both read", () => {
    const next = withApplicationFee(twoRooms(), "long", "60");
    for (const room of next.rooms) {
      expect(fee(next, room.id, { leaseTerm: "Long-term" })).toBe(60);
      expect(termFeeText(longTermPrivateArrangementRow(room), "applicationFee", "long").value).toBe("60");
    }
    expect(readApplicationFeeInput(next, "long")).toEqual({ value: "60", placeholder: "", varies: false });
  });

  it("a Short term fee lands on the Short term entry and leaves long-term alone", () => {
    const next = withApplicationFee(twoRooms(), "short", "25");
    expect(fee(next, "r1", { rentalType: "short_term" })).toBe(25);
    expect(next.rooms[0]!.termPricing?.[SHORT_TERM_LEASE_TERM]?.applicationFee).toBe("25");
    expect(longTermPrivateArrangementRow(next.rooms[0]!).applicationFee ?? "").toBe("");
    expect(readApplicationFeeInput(next, "short").value).toBe("25");
  });

  it("rooms that differ show the range and keep their own values until a fee is typed", () => {
    const base = twoRooms();
    const mixed = withApplicationFee({ ...base, rooms: [base.rooms[0]!] }, "long", "40");
    const different: ManagerListingSubmissionV1 = {
      ...base,
      rooms: [mixed.rooms[0]!, withApplicationFee({ ...base, rooms: [base.rooms[1]!] }, "long", "55").rooms[0]!],
    };
    const read = readApplicationFeeInput(different, "long");
    expect(read.varies).toBe(true);
    expect(read.value).toBe("");
    expect(read.placeholder).toBe("From $40");
    expect(withApplicationFee(different, "long", "50").rooms.map((room) => fee(withApplicationFee(different, "long", "50"), room.id, { leaseTerm: "Long-term" }))).toEqual([50, 50]);
  });

  it("clearing the box clears the room's own fee so it inherits again", () => {
    const typed = withApplicationFee(twoRooms(), "long", "60");
    const cleared = withApplicationFee(typed, "long", "");
    expect(longTermPrivateArrangementRow(cleared.rooms[0]!).applicationFee ?? "").toBe("");
  });

  it("a whole-house listing keeps its fee on the whole-house row, long-term and Short term apart", () => {
    const whole = { ...createDefaultListingSubmission(), listingPlaceCategoryId: "entire_home" } as ManagerListingSubmissionV1;
    const typed = withApplicationFee(withApplicationFee(whole, "long", "80"), "short", "20");
    expect(typed.entireHomeArrangementFees?.applicationFee).toBe("80");
    expect(typed.entireHomeArrangementFees?.shortTermApplicationFee).toBe("20");
    const wholeFee = (input: Parameters<typeof placementFeeOptionsFor>[1]) =>
      resolvePlacementStandardFees(typed, placementFeeOptionsFor(typed, { ...input, wholeHouse: true })).applicationFee;
    expect(wholeFee({ leaseTerm: "Long-term" })).toBe(80);
    expect(wholeFee({ rentalType: "short_term" })).toBe(20);
    expect(readApplicationFeeInput(typed, "long").value).toBe("80");
  });

  it("the sanitiser keeps digits only, so a typed amount is never anything else", () => {
    const next = withApplicationFee(twoRooms(), "long", "$7a5.999");
    expect(longTermPrivateArrangementRow(next.rooms[0]!).applicationFee).toBe("75.99");
  });

  it("a Short-term application is priced on the short scope, every other form on long", () => {
    const short = createPropertyApplicationTemplate({ kind: "short-term", label: "Stay application" });
    const long = createPropertyApplicationTemplate({ kind: "long-term", label: "Lease application" });
    expect(applicationFeeScopeForTemplate(short)).toBe("short");
    expect(applicationFeeScopeForTemplate(long)).toBe("long");
  });
});

describe("Needed", () => {
  it("is on unless switched off, and an applicant is never served a form that is off", () => {
    const a = createPropertyApplicationTemplate({ kind: "long-term", label: "A" });
    expect(isApplicationTemplateOffered(a)).toBe(true);
    expect(isApplicationTemplateOffered({ ...a, offered: false })).toBe(false);
    const published = {
      ...a,
      publishedQuestionConfig: { version: 1, disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" as const },
    };
    const sub = { propertyApplicationTemplates: [published] };
    expect(publishedApplicationTemplateForApplicant(sub, "standard")?.id).toBe(a.id);
    expect(publishedApplicationTemplateForApplicant({ propertyApplicationTemplates: [{ ...published, offered: false }] }, "standard")).toBeNull();
  });
});

describe("application <-> lease: one link, two views", () => {
  const l1 = createPropertyLeaseTemplate({ kind: "long-term", label: "Long lease", source: "axis_default" });
  const l2 = createPropertyLeaseTemplate({ kind: "long-term", label: "Other lease", source: "axis_default" });
  const a1 = createPropertyApplicationTemplate({ kind: "long-term", label: "A1" });
  const a2 = createPropertyApplicationTemplate({ kind: "long-term", label: "A2" });
  const cosigner = { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Co-signer" }), formVariant: "cosigner" as const, listingSeedKey: "cosigner" as const };
  const catalog = { applications: [a1, a2, cosigner], leases: [l1, l2] };

  it("linking from the application is seen from the lease", () => {
    const applications = linkApplicationToLease(catalog, a1.id, l2.id);
    const next = { applications, leases: catalog.leases };
    expect(leaseOfApplication(next, a1.id)).toBe(l2.id);
    expect(applicationsOfLease(next, l2.id).map((row) => row.id)).toEqual([a1.id]);
    expect(applicationsOfLease(next, l1.id)).toEqual([]);
  });

  it("linking from the lease moves an application there (it can only lead to one lease) and releases the unpicked", () => {
    const first = { applications: linkApplicationToLease(catalog, a1.id, l1.id), leases: catalog.leases };
    const both = { applications: setApplicationsOfLease(first, l2.id, [a1.id, a2.id]), leases: catalog.leases };
    expect(leaseOfApplication(both, a1.id)).toBe(l2.id);
    expect(leaseOfApplication(both, a2.id)).toBe(l2.id);
    expect(applicationsOfLease(both, l1.id)).toEqual([]);
    const released = { applications: setApplicationsOfLease(both, l2.id, [a2.id]), leases: catalog.leases };
    expect(leaseOfApplication(released, a1.id)).toBeNull();
    expect(leaseOfApplication(released, a2.id)).toBe(l2.id);
  });

  it("a co-signer form is never mapped, and a deleted lease releases its applications", () => {
    expect(linkApplicationToLease(catalog, cosigner.id, l1.id).find((row) => row.id === cosigner.id)!.linkedLeaseTemplateId).toBeUndefined();
    const linked = linkApplicationToLease(catalog, a1.id, l1.id);
    const after = releaseDeletedLeaseLinks(linked, [l2]);
    expect(leaseOfApplication({ applications: after, leases: [l2] }, a1.id)).toBeNull();
  });
});

describe("Allow custom dates / Allow month-to-month write both places", () => {
  function withSeededLease() {
    const base = createDefaultListingSubmission();
    return syncPropertyLeaseTemplatesFromListing(addLeaseTemplateFromSeed(base, "primary"));
  }

  it("a single lease: its applicationLeaseTerms AND the listing's allowedLeaseTerms", () => {
    const sub = withSeededLease();
    const lease = readPropertyLeaseTemplates(sub)[0]!;
    const on = submissionWithLeaseOption(sub, readPropertyLeaseTemplates(sub), lease.id, "custom", true);
    expect(readPropertyLeaseTemplates(on)[0]!.applicationLeaseTerms).toContain("Custom");
    expect(resolveAllowedLeaseTerms(on)).toContain("Custom");
    // a seeded lease re-derives its terms from allowedLeaseTerms on every sync: the two must agree
    expect(readPropertyLeaseTemplates(syncPropertyLeaseTemplatesFromListing(on))[0]!.applicationLeaseTerms).toContain("Custom");
    const off = submissionWithLeaseOption(on, readPropertyLeaseTemplates(on), lease.id, "custom", false);
    expect(resolveAllowedLeaseTerms(off)).not.toContain("Custom");
    expect(readPropertyLeaseTemplates(syncPropertyLeaseTemplatesFromListing(off))[0]!.applicationLeaseTerms).not.toContain("Custom");
  });

  it("the bulk path uses the same helper, per property, touching only the touched terms", () => {
    const sub = withSeededLease();
    const templates = readPropertyLeaseTemplates(sub);
    const next = submissionWithLeaseOption(sub, templates, templates[0]!.id, "monthToMonth", true);
    const bulk = submissionWithLeaseTemplates(sub, readPropertyLeaseTemplates(next), ["monthToMonth"]);
    expect(resolveAllowedLeaseTerms(bulk)).toContain("Month-to-Month");
    const untouched = submissionWithLeaseTemplates(sub, readPropertyLeaseTemplates(next), []);
    expect(resolveAllowedLeaseTerms(untouched)).toEqual(resolveAllowedLeaseTerms(sub));
  });
});

describe("questions, drafts and copies", () => {
  it("an inline question edit writes the draft; publishing it makes it what applicants get, once", () => {
    const sub = withPropertyApplicationTemplatesExplicit(createDefaultListingSubmission(), [createPropertyApplicationTemplate({ kind: "long-term", label: "Main" })]);
    const template = readPropertyApplicationTemplates(sub)[0]!;
    const edited = withQuestionSlice(template, { ...questionSliceForTemplate(sub, template), customApplicationFields: [] });
    expect(edited.draftQuestionConfig?.applicationConfigMode).toBe("custom");
    const withDraft = withPropertyApplicationTemplatesExplicit(sub, [edited]);
    const published = publishPendingApplicationDrafts(withDraft);
    const stored = readPropertyApplicationTemplates(published)[0]!;
    expect(stored.publishedQuestionConfig?.version).toBe(1);
    // nothing changed since: no new version, same object back
    expect(publishPendingApplicationDrafts(published)).toBe(published);
  });

  it("a new application starts from the PropLane standard or copies an existing one, and is never a seeded default", () => {
    const sub = createDefaultListingSubmission();
    const main = createPropertyApplicationTemplate({ kind: "long-term", label: "Main" });
    const fresh = createInlineApplication(sub, [main], "proplane");
    expect(fresh.label).toBe("New application");
    expect(fresh.listingSeedKey).toBeUndefined();
    expect(fresh.draftQuestionConfig?.applicationConfigMode).toBe("custom");
    const copy = createInlineApplication(sub, [main], main.id);
    expect(copy.label).toBe("Main copy");
    expect(uniqueFormLabel(["Main", "Main copy"], "Main copy")).toBe("Main copy 2");
  });

  it("a duplicate lease is the manager's own: not seeded, no routed lease types", () => {
    const sub = syncPropertyLeaseTemplatesFromListing(addLeaseTemplateFromSeed(createDefaultListingSubmission(), "primary"));
    const templates = readPropertyLeaseTemplates(sub);
    const copy = duplicateLeaseTemplate(templates, templates[0]!.id)!;
    expect(copy.id).not.toBe(templates[0]!.id);
    expect(copy.listingSeedKey).toBeUndefined();
    expect(copy.applicationLeaseTerms).toBeUndefined();
    expect(copy.label).toMatch(/copy$/);
  });
});
