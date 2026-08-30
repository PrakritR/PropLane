import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  buildPropertyLeasePreview,
  formatLeaseAddressForDisplay,
  stripLeaseHtmlToPlainText,
  truncateLeasePreviewText,
} from "@/lib/property-lease-preview";
import {
  applyPropertyLeaseDocumentMode,
  documentModeFromLease,
  draftFieldsFromLeaseSource,
  propertyLeaseDocumentModeLabel,
  propertyLeaseSourceLabel,
  resolvePropertyLeaseSource,
} from "@/lib/property-lease-source";

function subWith(patch: Partial<ManagerListingSubmissionV1>): ManagerListingSubmissionV1 {
  return { ...createDefaultListingSubmission(), ...patch };
}

const seattleRoomSub = () =>
  subWith({
    buildingName: "The Pioneer",
    address: "12 Pike St, Seattle, WA",
    zip: "98101",
    neighborhood: "Pioneer Square",
    tagline: "Please message with a short bio and preferred move in date to be considered.",
    securityDeposit: "$500.00",
    moveInFee: "$150.00",
    houseRulesText: "Quiet hours 10pm–8am · No smoking",
    houseOverview: "Light-filled Pioneer Square home with shared kitchen.",
    amenitiesText: "In-unit laundry\nSecure entry",
    petFriendly: true,
    parkingMonthly: "$120.00",
    allowedLeaseTerms: ["12-Month"],
    rooms: [
      {
        id: "r1",
        name: "12A",
        monthlyRent: 2400,
        floor: "",
        utilitiesEstimate: "$85",
        prorateMethod: "auto",
        dailyRentRate: 0,
        dailyUtilitiesRate: 0,
        photoDataUrls: [],
        videoDataUrl: null,
        amenitiesText: "",
        bathroomAccessIds: [],
        sharedSpaceAccessIds: [],
      },
    ],
  });

describe("property lease source", () => {
  it("maps stored fields to UI source ids", () => {
    expect(resolvePropertyLeaseSource(subWith({}))).toBe("axis_default");
    expect(resolvePropertyLeaseSource(subWith({ leaseConfigMode: "standard" }))).toBe("axis_default");
    expect(
      resolvePropertyLeaseSource(subWith({ leaseConfigMode: "custom", leaseCustomKind: "terms", customLeaseTerms: "X" })),
    ).toBe("custom_comments");
    expect(
      resolvePropertyLeaseSource(subWith({ leaseConfigMode: "custom", leaseCustomKind: "document" })),
    ).toBe("custom_format");
  });

  it("round-trips draft fields from source ids", () => {
    expect(draftFieldsFromLeaseSource("axis_default")).toEqual({ leaseConfigMode: "standard", leaseCustomKind: "terms" });
    expect(draftFieldsFromLeaseSource("custom_comments")).toEqual({
      leaseConfigMode: "custom",
      leaseCustomKind: "terms",
    });
    expect(draftFieldsFromLeaseSource("custom_format")).toEqual({
      leaseConfigMode: "custom",
      leaseCustomKind: "document",
    });
  });

  it("labels sources for display", () => {
    expect(propertyLeaseSourceLabel("axis_default")).toBe("PropLane default");
    expect(propertyLeaseSourceLabel("custom_comments")).toBe("Custom clauses");
    expect(propertyLeaseSourceLabel("custom_format")).toBe("Your PDF");
  });

  it("maps document modes to stored fields", () => {
    expect(documentModeFromLease("axis_default", "long-term")).toBe("proplane_long_term");
    expect(documentModeFromLease("axis_default", "short-term")).toBe("proplane_short_term");
    expect(documentModeFromLease("custom_format", "long-term")).toBe("upload");
    expect(applyPropertyLeaseDocumentMode("proplane_short_term")).toMatchObject({
      source: "axis_default",
      kind: "short-term",
    });
    expect(propertyLeaseDocumentModeLabel("proplane_long_term")).toContain("long term");
  });
});

describe("formatLeaseAddressForDisplay", () => {
  it("does not duplicate city/state when address already includes Seattle, WA", () => {
    const lines = formatLeaseAddressForDisplay({
      address: "12 Pike St, Seattle, WA",
      neighborhood: "Pioneer Square",
      zip: "98101",
    });
    expect(lines.full).not.toMatch(/Seattle, WA.*Seattle, WA/);
    expect(lines.street).toBe("12 Pike St");
  });
});

describe("property lease preview", () => {
  it("uses generic PropLane default draft without listing-specific details", () => {
    const preview = buildPropertyLeasePreview(seattleRoomSub(), { demo: true });
    expect(preview.source).toBe("axis_default");
    expect(preview.html).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
    expect(preview.html).not.toContain("The Pioneer");
    expect(preview.html).not.toContain("[Resident name]");
    expect(preview.html).toContain("Filled at placement");
    expect(preview.html).not.toContain("$2400.00 / month");
    expect(preview.html).not.toContain("$500.00");
    expect(preview.html).not.toContain("Quiet hours 10pm");
    expect(preview.html).not.toContain("12 Pike St");
    expect(preview.html).toContain("Electronic Signature");
    expect(preview.jurisdictionLabel).toBe("Seattle, WA");
  });

  it("generates a distinct short-term stay agreement for short-term template kind", () => {
    const sub = seattleRoomSub();
    const longPreview = buildPropertyLeasePreview(sub, { templateKind: "long-term" });
    const shortPreview = buildPropertyLeasePreview(
      {
        ...sub,
        shortTermDailyCost: "$95",
        shortTermDeposit: "$200",
      },
      { templateKind: "short-term" },
    );
    expect(longPreview.html).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
    expect(shortPreview.html).toContain("SHORT-TERM ROOM STAY AGREEMENT");
    expect(shortPreview.html).not.toContain("RESIDENTIAL LEASE AGREEMENT");
    expect(shortPreview.html).toContain("Guest");
    expect(shortPreview.html).not.toContain("[Resident name]");
    expect(shortPreview.html).not.toContain("The Pioneer");
    expect(shortPreview.html).not.toContain("$95");
    expect(shortPreview.html).not.toContain("$200");
    expect(shortPreview.html).not.toContain("10:00 PM");
    expect(shortPreview.html).not.toContain("11:00 AM");
  });

  it("does not embed listing marketing copy in section 2 Premises", () => {
    const preview = buildPropertyLeasePreview(seattleRoomSub(), { demo: true });
    expect(preview.html).toContain("<h2>1. Parties and Premises</h2>");
    expect(preview.html).toContain("Filled at placement");
    expect(preview.html).not.toContain("The Pioneer");
    expect(preview.html).not.toContain("$2400.00 / month");
    expect(preview.html).not.toContain("Light-filled Pioneer Square home");
    expect(preview.html).not.toContain("Please message with a short bio");
    expect(preview.html).not.toContain("preferred move in date");
  });

  it("renders custom comments as full lease with numbered addendum when supported", () => {
    const preview = buildPropertyLeasePreview(
      subWith({
        ...seattleRoomSub(),
        leaseConfigMode: "custom",
        leaseCustomKind: "terms",
        customLeaseTerms: "No smoking on balconies.\nParking spot #4 only.",
      }),
    );
    expect(preview.source).toBe("custom_comments");
    expect(preview.html).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
    expect(preview.html).toContain("Additional Provisions from Property Manager");
    expect(preview.html).toContain("No smoking on balconies.");
    expect(preview.html).toContain("Parking spot #4 only.");
    expect(preview.html).toMatch(/<ol>[\s\S]*No smoking on balconies/);
  });

  it("renders custom format notice only when template is set", () => {
    const preview = buildPropertyLeasePreview(
      subWith({
        ...seattleRoomSub(),
        leaseConfigMode: "custom",
        leaseCustomKind: "document",
        leaseTemplateDocUrl: "data:application/pdf;base64,abc",
        leaseTemplateDocName: "My Lease.pdf",
      }),
    );
    expect(preview.source).toBe("custom_format");
    expect(preview.html).toContain("My Lease.pdf");
    expect(preview.html).toContain("Custom lease format");
    expect(preview.html).not.toContain("RESIDENTIAL ROOM RENTAL AGREEMENT");
  });

  it("strips and truncates html for panel snippets", () => {
    const plain = stripLeaseHtmlToPlainText("<style>h1{}</style><h1>Lease</h1><p>Hello &amp; welcome.</p>");
    expect(plain).toContain("Lease");
    expect(plain).toContain("Hello & welcome.");
    expect(truncateLeasePreviewText("a".repeat(500), 100)).toHaveLength(101);
    expect(truncateLeasePreviewText("short", 100)).toBe("short");
  });
});
