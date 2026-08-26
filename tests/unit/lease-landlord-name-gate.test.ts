/**
 * A lease must never name "[LANDLORD ENTITY NAME]" as a contracting party.
 *
 * The template had no landlord name to print — PropLane never collected one — so it fell back to
 * the listing's BUILDING name, which is a place rather than a legal person, and then to that
 * literal placeholder, which shipped onto the Parties and signature blocks of documents residents
 * were asked to sign.
 *
 * The fix is two-sided and both halves matter: the manager's account full name is used as the
 * landlord party, and the send gate refuses any lease still carrying the placeholder. Shipping the
 * the send gate refuses any lease still carrying the placeholder. Shipping the gate WITHOUT the
 * field would have blocked every send with no way out, which is why these assert the escape hatch
 * as carefully as the block.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  leaseLandlordNameBlocker,
  leaseLandlordPartyNameFromHtml,
} from "@/lib/lease-pipeline-storage";
import {
  LEASE_LANDLORD_PLACEHOLDER,
  MAX_LANDLORD_LEGAL_NAME_LENGTH,
  cacheLandlordLegalName,
  landlordLegalNameFromAccountFullName,
  normalizeManagerLandlordProfile,
  validateLandlordLegalName,
} from "@/lib/manager-landlord-profile";

const row = (over: Record<string, unknown> = {}) =>
  ({ id: "lease-1", residentEmail: "a@b.com", ...over }) as never;

const partiesHtml = (landlordName: string) =>
  `<table><tr><th>Landlord / Operator</th><td><strong>${landlordName}</strong><br/>Mailing address: 1 Main</td></tr></table>`;

describe("landlord-name send gate", () => {
  beforeEach(() => {
    cacheLandlordLegalName("Doe Property Holdings LLC");
  });

  afterEach(() => {
    cacheLandlordLegalName("");
  });

  it("blocks a lease that still names the placeholder", () => {
    const blocker = leaseLandlordNameBlocker(
      row({ generatedHtml: `<p>Landlord: ${LEASE_LANDLORD_PLACEHOLDER}</p>` }),
    );
    expect(blocker).toBeTruthy();
    expect(blocker).toMatch(/Settings/i);
    expect(blocker).toMatch(/regenerate/i);
  });

  it("blocks when the manager has not configured a profile name", () => {
    cacheLandlordLegalName("");
    expect(leaseLandlordNameBlocker(row({ generatedHtml: partiesHtml("5259 Brooklyn Ave NE") }))).toMatch(
      /Settings/i,
    );
  });

  it("blocks when the parties row does not match the configured landlord name", () => {
    expect(leaseLandlordNameBlocker(row({ generatedHtml: partiesHtml("5259 Brooklyn Ave NE") }))).toMatch(
      /Regenerate/i,
    );
  });

  it("allows a lease that names the configured landlord", () => {
    expect(
      leaseLandlordNameBlocker(row({ generatedHtml: partiesHtml("Doe Property Holdings LLC") })),
    ).toBeNull();
  });

  it("reads the landlord party from the parties row", () => {
    expect(leaseLandlordPartyNameFromHtml(partiesHtml("Jane Doe"))).toBe("Jane Doe");
  });

  it("ignores a row with no generated document", () => {
    expect(leaseLandlordNameBlocker(row())).toBeNull();
    expect(leaseLandlordNameBlocker(row({ managerUploadedPdf: { dataUrl: "data:..." } }))).toBeNull();
  });
});

describe("landlord legal name validation", () => {
  it("derives the lease landlord name from account full name", () => {
    expect(landlordLegalNameFromAccountFullName("Jane Doe")).toBe("Jane Doe");
    expect(landlordLegalNameFromAccountFullName("  Doe   Holdings   LLC ")).toBe("Doe Holdings LLC");
    expect(landlordLegalNameFromAccountFullName("")).toBe("");
  });

  it("accepts a person and an entity", () => {
    expect(validateLandlordLegalName("Jane Doe")).toEqual({ ok: true, landlordLegalName: "Jane Doe" });
    expect(validateLandlordLegalName("Doe Property Holdings LLC")).toEqual({
      ok: true,
      landlordLegalName: "Doe Property Holdings LLC",
    });
  });

  it("allows clearing the name", () => {
    // A manager may be mid-setup. The send gate, not the field, is what protects the document.
    expect(validateLandlordLegalName("")).toEqual({ ok: true, landlordLegalName: "" });
    expect(validateLandlordLegalName(null)).toEqual({ ok: true, landlordLegalName: "" });
    expect(validateLandlordLegalName("   ")).toEqual({ ok: true, landlordLegalName: "" });
  });

  it("collapses stray whitespace rather than printing it on a contract", () => {
    expect(validateLandlordLegalName("  Doe   Holdings   LLC ")).toEqual({
      ok: true,
      landlordLegalName: "Doe Holdings LLC",
    });
  });

  it("rejects a single stray character", () => {
    expect(validateLandlordLegalName("x").ok).toBe(false);
  });

  it("rejects angle brackets", () => {
    expect(validateLandlordLegalName("<script>").ok).toBe(false);
  });

  it("rejects an absurdly long value", () => {
    expect(validateLandlordLegalName("A".repeat(MAX_LANDLORD_LEGAL_NAME_LENGTH + 1)).ok).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(validateLandlordLegalName(42).ok).toBe(false);
  });
});

describe("stored landlord profile", () => {
  it("reads a missing or junk row as unset", () => {
    for (const raw of [null, undefined, {}, "nope", 7, []]) {
      expect(normalizeManagerLandlordProfile(raw).landlordLegalName).toBe("");
    }
  });

  it("truncates rather than storing an unbounded name", () => {
    const long = normalizeManagerLandlordProfile({ landlordLegalName: "A".repeat(500) });
    expect(long.landlordLegalName).toHaveLength(MAX_LANDLORD_LEGAL_NAME_LENGTH);
  });
});
