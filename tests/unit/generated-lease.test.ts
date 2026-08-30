import { describe, expect, it } from "vitest";
import { snapshotJordanLee } from "@/data/manager-application-snapshots";
import {
  buildAiGeneratedLeaseHtml,
  leaseContextFromApplication,
  selectLeaseTemplateDoc,
} from "@/lib/generated-lease";
import { LEASE_AI_REVIEW_DISCLAIMER } from "@/lib/lease-templates/types";
import { resolveApplicationPersonalFields } from "@/lib/application-personal-fields";

function generatedLeaseHtml(ctx: Parameters<typeof buildAiGeneratedLeaseHtml>[0]): string {
  const outcome = buildAiGeneratedLeaseHtml(ctx);
  if (outcome.kind !== "generated") throw new Error(outcome.error);
  return outcome.html;
}

function listingAt(address: string, neighborhood: string) {
  return {
    id: "location-test",
    title: "Location test",
    tagline: "",
    address,
    zip: "00000",
    neighborhood,
    beds: 1,
    baths: 1,
    rentLabel: "$1,000 / month",
    available: "Now",
    petFriendly: false,
    buildingId: "location-building",
    buildingName: "Location test",
    unitLabel: "Room 1",
    adminPublishLive: true,
  };
}

describe("generated-lease", () => {
  it("selects uploaded templates only for their configured stay kind", () => {
    const base = leaseContextFromApplication(snapshotJordanLee());
    const ctx = {
      ...base,
      submission: {
        ...(base.submission ?? { v: 1, rooms: [], bathrooms: [], sharedSpaces: [], bundles: [], quickFacts: [] }),
        propertyLeaseTemplates: [
          {
            id: "long-v1",
            kind: "long-term",
            label: "Long-term lease",
            listingSeedKey: "primary",
            leaseConfigMode: "custom",
            leaseCustomKind: "document",
            customLeaseTerms: "",
            leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/long.pdf",
            leaseTemplateDocName: "Long-term.pdf",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
          {
            id: "short-v1",
            kind: "short-term",
            label: "Short-term agreement",
            listingSeedKey: "short-term",
            leaseConfigMode: "custom",
            leaseCustomKind: "document",
            customLeaseTerms: "",
            leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/short.pdf",
            leaseTemplateDocName: "Short-term.pdf",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    };

    expect(selectLeaseTemplateDoc(ctx, "long")).toMatchObject({ name: "Long-term.pdf" });
    expect(selectLeaseTemplateDoc(ctx, "short")).toMatchObject({ name: "Short-term.pdf" });
  });

  it("does not fall back to a long-term upload for a short stay", () => {
    const base = leaseContextFromApplication(snapshotJordanLee());
    const ctx = {
      ...base,
      submission: {
        ...(base.submission ?? { v: 1, rooms: [], bathrooms: [], sharedSpaces: [], bundles: [], quickFacts: [] }),
        leaseConfigMode: "custom" as const,
        leaseCustomKind: "document" as const,
        leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/legacy.pdf",
        leaseTemplateDocName: "Legacy long-term.pdf",
      },
    };

    expect(selectLeaseTemplateDoc(ctx, "long")).toMatchObject({ name: "Legacy long-term.pdf" });
    expect(selectLeaseTemplateDoc(ctx, "short")).toBeNull();
  });

  it("builds the generated stay agreement when a short stay has only a long-term upload", () => {
    const base = leaseContextFromApplication({
      ...snapshotJordanLee(),
      rentalType: "short_term",
      leaseStart: "2026-03-10",
      leaseEnd: "2026-03-16",
    });
    const ctx = {
      ...base,
      leasedRoom: undefined,
      listingProperty: base.listingProperty
        ? { ...base.listingProperty, address: "5259 Brooklyn Ave NE, Seattle, WA", neighborhood: "Seattle" }
        : undefined,
      submission: {
        ...(base.submission ?? { v: 1, rooms: [], bathrooms: [], sharedSpaces: [], bundles: [], quickFacts: [] }),
        shortTermRentalsAllowed: true,
        shortTermDailyCost: "85",
        leaseConfigMode: "custom" as const,
        leaseCustomKind: "document" as const,
        leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/legacy.pdf",
        leaseTemplateDocName: "Legacy long-term.pdf",
      },
    };

    const html = generatedLeaseHtml(ctx);
    expect(html).toContain("SHORT-TERM ROOM STAY AGREEMENT");
    expect(html).not.toContain("legacy.pdf");
  });

  it("does not mirror a short-only template into the long-term document", () => {
    const base = leaseContextFromApplication(snapshotJordanLee());
    const shortTemplate = {
      id: "short-v1",
      kind: "short-term" as const,
      label: "Short-term agreement",
      listingSeedKey: "short-term" as const,
      leaseConfigMode: "custom" as const,
      leaseCustomKind: "document" as const,
      customLeaseTerms: "",
      leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/short.pdf",
      leaseTemplateDocName: "Short-term.pdf",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const ctx = {
      ...base,
      // This mirrors submissionWithLeaseTemplateForApplication's legacy field
      // overlay. The selector must still use the array's stay-kind boundary.
      submission: {
        ...(base.submission ?? { v: 1, rooms: [], bathrooms: [], sharedSpaces: [], bundles: [], quickFacts: [] }),
        ...shortTemplate,
        propertyLeaseTemplates: [shortTemplate],
      },
    };

    expect(selectLeaseTemplateDoc(ctx, "short")).toMatchObject({ name: "Short-term.pdf" });
    expect(selectLeaseTemplateDoc(ctx, "long")).toBeNull();
  });

  it("rejects an arbitrary URL stored in editable listing data", () => {
    const base = leaseContextFromApplication(snapshotJordanLee());
    const ctx = {
      ...base,
      submission: {
        ...(base.submission ?? { v: 1, rooms: [], bathrooms: [], sharedSpaces: [], bundles: [], quickFacts: [] }),
        leaseConfigMode: "custom" as const,
        leaseCustomKind: "document" as const,
        leaseTemplateDocUrl: "https://example.test/manager-lease.pdf",
        leaseTemplateDocName: "Not a stored template.pdf",
      },
    };

    expect(selectLeaseTemplateDoc(ctx, "long")).toBeNull();
  });

  it("renders one binding Terms Rider rather than a placement summary above an uploaded template", () => {
    const base = leaseContextFromApplication({
      ...snapshotJordanLee(),
      managerRentOverride: "1250",
      managerSecurityDepositOverride: "300",
    });
    const ctx = {
      ...base,
      submission: {
        ...(base.submission ?? { v: 1, rooms: [], bathrooms: [], sharedSpaces: [], bundles: [], quickFacts: [] }),
        propertyLeaseTemplates: [
          {
            id: "long-v1",
            kind: "long-term",
            label: "Long-term lease",
            listingSeedKey: "primary",
            leaseConfigMode: "custom",
            leaseCustomKind: "document",
            customLeaseTerms: "",
            leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/long.pdf",
            leaseTemplateDocName: "Long-term.pdf",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    };

    const html = generatedLeaseHtml(ctx);
    expect(html).toContain("TERMS RIDER");
    expect(html).toContain("this Terms Rider controls for that conflict");
    expect(html).toContain("$1,250");
    expect(html).toContain("$300");
    expect(html).not.toContain("Placement Summary");
  });

  it("builds lease context from application snapshot", () => {
    const app = snapshotJordanLee();
    const ctx = leaseContextFromApplication({
      ...app,
      propertyId: app.propertyId,
    });
    const withSeattle = {
      ...ctx,
      leasedRoom: undefined,
      listingProperty: ctx.listingProperty
        ? { ...ctx.listingProperty, address: "5259 Brooklyn Ave NE, Seattle, WA", neighborhood: "Seattle" }
        : ctx.listingProperty,
    };
    expect(withSeattle.application.fullLegalName).toContain("Jordan");
    expect(withSeattle.generatedAtIso).toBeTruthy();
    const html = generatedLeaseHtml(withSeattle);
    expect(html).not.toContain(LEASE_AI_REVIEW_DISCLAIMER);
    expect(html).toContain("State of Washington");
  });

  it("includes phone, email, and date of birth in generated lease html", () => {
    const app = snapshotJordanLee();
    const ctx = leaseContextFromApplication(app);
    const withSeattle = {
      ...ctx,
      leasedRoom: undefined,
      listingProperty: ctx.listingProperty
        ? { ...ctx.listingProperty, address: "5259 Brooklyn Ave NE, Seattle, WA", neighborhood: "Seattle" }
        : undefined,
    };
    const html = generatedLeaseHtml(withSeattle);
    expect(html).toContain("(206) 555-0142");
    expect(html).toContain("jordan.lee@example.com");
    expect(html).toContain("1998-03-14");
  });

  it("names the configured landlord legal name in the parties row instead of the building", () => {
    const app = snapshotJordanLee();
    const ctx = leaseContextFromApplication(app);
    const withLandlord = {
      ...ctx,
      landlordLegalName: "Ambika Mago",
      listingProperty: ctx.listingProperty
        ? { ...ctx.listingProperty, buildingName: "5259 Brooklyn Ave NE", address: "5259 Brooklyn Ave NE, Seattle, WA" }
        : ctx.listingProperty,
    };
    const html = generatedLeaseHtml(withLandlord);
    expect(html).toContain("<strong>Ambika Mago</strong>");
    expect(html).not.toContain("<strong>5259 Brooklyn Ave NE</strong>");
  });

  it("renders San Francisco governing law when address is in SF", () => {
    const app = snapshotJordanLee();
    const ctx = leaseContextFromApplication(app);
    const baseListing = ctx.listingProperty ?? {
      id: "sf-test",
      title: "SF House",
      tagline: "",
      address: "",
      zip: "94103",
      neighborhood: "SOMA",
      beds: 1,
      baths: 1,
      rentLabel: "$1000",
      available: "Now",
      petFriendly: false,
      buildingId: "b1",
      buildingName: "SF House",
      unitLabel: "Room 1",
      adminPublishLive: true,
    };
    const sfCtx = {
      ...ctx,
      leasedRoom: undefined,
      listingProperty: {
        ...baseListing,
        address: "123 Market St, San Francisco, CA",
        neighborhood: "SOMA",
      },
    };
    const html = generatedLeaseHtml(sfCtx);
    expect(html).toContain("State of California");
    expect(html).toContain("San Francisco");
    expect(html).not.toContain(LEASE_AI_REVIEW_DISCLAIMER);
  });

  it("uses statewide California terms for Fremont and records the state jurisdiction", () => {
    const base = leaseContextFromApplication(snapshotJordanLee());
    const ctx = {
      ...base,
      leasedRoom: undefined,
      listingProperty: listingAt("39100 Civic Center Dr, Fremont, CA", "Fremont"),
    };
    const outcome = buildAiGeneratedLeaseHtml(ctx);
    expect(outcome.kind).toBe("generated");
    if (outcome.kind !== "generated") return;
    expect(outcome.html).toContain("State of California");
    expect(outcome.html).not.toContain("San Francisco Rent Ordinance");
    expect(outcome.executedJurisdiction).toBe("US-CA");
  });

  it("uses statewide Washington terms for Spokane without Seattle branding", () => {
    const base = leaseContextFromApplication(snapshotJordanLee());
    const ctx = {
      ...base,
      leasedRoom: undefined,
      listingProperty: listingAt("808 W Spokane Falls Blvd, Spokane, WA", "Spokane"),
    };
    const html = generatedLeaseHtml(ctx);
    expect(html).toContain("State of Washington");
    expect(html).not.toContain("PROPLANE SEATTLE HOUSING");
    expect(html).not.toContain("ordinances of the City of Seattle");
  });

  it("returns a typed unsupported outcome for Austin without rendering a partial document", () => {
    const base = leaseContextFromApplication(snapshotJordanLee());
    const ctx = {
      ...base,
      leasedRoom: undefined,
      listingProperty: listingAt("301 W 2nd St, Austin, TX", "Austin"),
    };

    expect(buildAiGeneratedLeaseHtml(ctx)).toEqual({
      kind: "unsupported_jurisdiction",
      error: expect.stringMatching(/Upload a PDF lease/),
    });
  });

  it("fills personal fields from row-level fallbacks when application snapshot is sparse", () => {
    const personal = resolveApplicationPersonalFields({
      name: "Sam Rivera",
      email: "sam@example.com",
      application: {
        phone: "(206) 555-0199",
        dateOfBirth: "1995-07-04",
      },
    });
    const ctx = leaseContextFromApplication(personal);
    expect(ctx.application.fullLegalName).toBe("Sam Rivera");
    expect(ctx.application.email).toBe("sam@example.com");
    expect(ctx.application.phone).toBe("(206) 555-0199");
    expect(ctx.application.dateOfBirth).toBe("1995-07-04");
  });

  it("renders bundle premises and bundle price for bundle applications", () => {
    const app = { ...snapshotJordanLee(), bundleId: "bundle-two", roomChoice1: "", roomChoice2: "", roomChoice3: "" };
    const ctx = leaseContextFromApplication(app);
    const submission = {
      v: 1,
      buildingName: "Alder Row",
      bathrooms: [],
      customLeaseTerms: [],
      customApplicationFields: [],
      rooms: [
        { id: "room-1", name: "Room 1", monthlyRent: 1150 },
        { id: "room-2", name: "Room 2", monthlyRent: 1100 },
        { id: "room-3", name: "Room 3", monthlyRent: 1050 },
      ],
      bundles: [
        {
          id: "bundle-two",
          label: "Two or more rooms",
          price: "$2,150/mo",
          strikethrough: "",
          promo: "",
          roomsLine: "",
          includedRoomIds: ["room-1", "room-2"],
        },
      ],
    } as unknown as NonNullable<typeof ctx.submission>;
    const html = generatedLeaseHtml({ ...ctx, leasedRoom: undefined, submission });
    expect(html).toContain("Two or more rooms");
    expect(html).toContain("Room 1, Room 2");
    expect(html).toContain("$2,150/mo");
  });

  const RESIDENT_RESPONSIBLE_SENTENCE = "This estimate reflects the utilities the Resident is responsible for above.";
  const NO_BREAKDOWN_SENTENCE =
    "This covers a prorated share of household utilities including electricity, gas, water, sewer, trash, and high-speed internet as applicable to this property.";
  const ALL_INCLUDED_SENTENCE =
    "All utilities and services listed above are included in the monthly rent or paid by Landlord, up to any allowance shown.";

  const UTILITIES_FIGURE = "$175.00";

  function leaseHtmlWithUtilities(leaseUtilities?: unknown[], appOverrides?: Record<string, unknown>): string {
    const ctx = leaseContextFromApplication({
      ...snapshotJordanLee(),
      managerUtilitiesOverride: UTILITIES_FIGURE,
      ...(appOverrides ?? {}),
    });
    const submission = {
      ...(ctx.submission ?? { v: 1, rooms: [], bundles: [], bathrooms: [] }),
      v: 1,
      ...(leaseUtilities ? { leaseUtilities } : {}),
    } as unknown as NonNullable<typeof ctx.submission>;
    return generatedLeaseHtml({
      ...ctx,
      submission,
      leasedRoom: undefined,
      listingProperty: ctx.listingProperty
        ? {
            ...ctx.listingProperty,
            address: "5259 Brooklyn Ave NE, Seattle, WA",
            neighborhood: "Seattle",
            listingSubmission: submission,
          }
        : ctx.listingProperty,
    });
  }

  it("renders the per-utility responsibility breakdown in the lease when configured", () => {
    const html = leaseHtmlWithUtilities([
      { kind: "electricity", paidBy: "resident", setUpBy: "resident" },
      { kind: "water", paidBy: "included_in_rent", setUpBy: "manager", allowance: "$60/mo" },
      { kind: "other", paidBy: "manager", setUpBy: "manager", label: "Landscaping", notes: "weekly service" },
    ]);
    expect(html).toContain("Account set up by");
    expect(html).toContain("Included up to $60/mo");
    expect(html).toContain("Landscaping");
    expect(html).toContain("Landlord pays");
    expect(html).toContain(RESIDENT_RESPONSIBLE_SENTENCE);
    expect(html).not.toContain(ALL_INCLUDED_SENTENCE);
    expect(html).toContain(UTILITIES_FIGURE);
  });

  it("keeps the standard utilities prose when no breakdown is configured", () => {
    const html = leaseHtmlWithUtilities();
    expect(html).toContain(NO_BREAKDOWN_SENTENCE);
    expect(html).not.toContain(RESIDENT_RESPONSIBLE_SENTENCE);
    expect(html).not.toContain("Account set up by");
    expect(html).toContain(UTILITIES_FIGURE);
  });

  it("does not claim the resident is responsible when no utility is resident-paid", () => {
    const html = leaseHtmlWithUtilities([
      { kind: "electricity", paidBy: "included_in_rent", setUpBy: "manager" },
      { kind: "water", paidBy: "included_in_rent", setUpBy: "manager", allowance: "$60/mo" },
      { kind: "trash", paidBy: "manager", setUpBy: "manager" },
    ]);
    expect(html).toContain("Account set up by");
    expect(html).toContain(ALL_INCLUDED_SENTENCE);
    expect(html).not.toContain(RESIDENT_RESPONSIBLE_SENTENCE);
    expect(html).not.toContain(NO_BREAKDOWN_SENTENCE);
    expect(html).toContain(UTILITIES_FIGURE);
    expect(html).toContain("monthly utilities of");
    expect(html).not.toContain("no separate monthly utilities / RUBS charge is due from Resident");
  });

  it("keeps quoting and prorating the billable utilities estimate whatever the breakdown says", () => {
    const allIncluded = [
      { kind: "electricity", paidBy: "included_in_rent", setUpBy: "manager" },
      { kind: "water", paidBy: "included_in_rent", setUpBy: "manager" },
    ];
    const residentPaid = [
      { kind: "electricity", paidBy: "resident", setUpBy: "resident" },
      { kind: "water", paidBy: "included_in_rent", setUpBy: "manager" },
    ];
    const midMonth = { leaseStart: "2026-06-15", managerRentOverride: "$1800" };
    const withResidentPaid = leaseHtmlWithUtilities(residentPaid, midMonth);
    expect(withResidentPaid).toContain("For the first partial month");
    expect(withResidentPaid).toContain("prorated rent and utilities");

    const withNoneResidentPaid = leaseHtmlWithUtilities(allIncluded, midMonth);
    expect(withNoneResidentPaid).toContain("For the first partial month");
    expect(withNoneResidentPaid).toContain("prorated rent and utilities");
    expect(withNoneResidentPaid).toContain(UTILITIES_FIGURE);
  });

  it("renders entire-home premises and rent for whole-house applications", () => {
    const app = { ...snapshotJordanLee(), bundleId: "", roomChoice1: "some-property-id", roomChoice2: "", roomChoice3: "" };
    const ctx = leaseContextFromApplication(app);
    const submission = {
      v: 1,
      buildingName: "Meadow Brook Village",
      listingPlaceCategoryId: "entire_home",
      entireHomeMonthlyRent: 2800,
      bathrooms: [],
      customLeaseTerms: [],
      customApplicationFields: [],
      rooms: [],
      bundles: [],
    } as unknown as NonNullable<typeof ctx.submission>;
    const html = generatedLeaseHtml({ ...ctx, leasedRoom: undefined, submission });
    expect(html).toContain("Entire home");
    expect(html).toContain("$2800.00 / month");
  });
});
