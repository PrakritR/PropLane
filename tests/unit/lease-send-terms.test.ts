// The Send lease screen's four terms (Start · End · Rent · Deposit), the PDF-beside-terms
// comparison, and the first-of-next-month rule behind "Monthly rent from Dec 1".
import { describe, expect, it } from "vitest";
import {
  firstOfNextMonth,
  leaseSendTermsEqual,
  leaseSendTermsPatch,
  overrideTextForTerm,
  pdfTermRows,
  resolvePdfTermPicks,
  termValueFromPdf,
  validateLeaseSendTerms,
  type LeaseSendTerms,
} from "@/lib/lease-send-terms";
import type { UploadedLeaseParse, UploadedLeaseField, UploadedLeaseFieldKey } from "@/lib/uploaded-lease-extraction";

const terms = (over: Partial<LeaseSendTerms> = {}): LeaseSendTerms => ({
  start: "2026-11-15",
  end: "2027-11-14",
  rent: "1750",
  deposit: "1750",
  ...over,
});

function field(key: UploadedLeaseFieldKey, value: string, status: UploadedLeaseField["status"] = "extracted"): UploadedLeaseField {
  return { key, label: key, status, value: status === "extracted" ? value : "", normalized: null, source: null, candidates: [], mapsTo: null };
}

function parse(fields: UploadedLeaseField[], overrides?: Partial<Record<UploadedLeaseFieldKey, string>>): UploadedLeaseParse {
  return {
    version: 1,
    status: "parsed",
    sourceFileName: "lease.pdf",
    sourceSha256: "a".repeat(64),
    pageCount: 4,
    characterCount: 1000,
    extractedAtIso: "2026-10-01T00:00:00.000Z",
    sections: [],
    fields,
    review: { status: "needs_review", overrides },
  };
}

describe("validateLeaseSendTerms", () => {
  it("accepts a complete set of terms", () => {
    expect(validateLeaseSendTerms(terms())).toEqual({ ok: true });
  });

  it("names the field that is wrong", () => {
    expect(validateLeaseSendTerms(terms({ start: "" }))).toMatchObject({ ok: false, field: "start" });
    expect(validateLeaseSendTerms(terms({ end: "2026-01-01" }))).toMatchObject({ ok: false, field: "end" });
    expect(validateLeaseSendTerms(terms({ rent: "" }))).toMatchObject({ ok: false, field: "rent" });
    expect(validateLeaseSendTerms(terms({ rent: "0" }))).toMatchObject({ ok: false, field: "rent" });
  });

  it("lets the deposit be 0 or blank but not nonsense", () => {
    expect(validateLeaseSendTerms(terms({ deposit: "0" }))).toEqual({ ok: true });
    expect(validateLeaseSendTerms(terms({ deposit: "" }))).toEqual({ ok: true });
  });
});

describe("leaseSendTermsPatch", () => {
  it("writes the four terms into the application fields the ledger and the lease read", () => {
    expect(leaseSendTermsPatch(terms({ rent: "1,750.50", deposit: "500" }))).toEqual({
      leaseStart: "2026-11-15",
      leaseEnd: "2027-11-14",
      managerRentOverride: "1750.5",
      managerSecurityDepositOverride: "500",
    });
  });

  it("compares money by value, not by how it was typed", () => {
    expect(leaseSendTermsEqual(terms({ rent: "1750" }), terms({ rent: "1750.00" }))).toBe(true);
    expect(leaseSendTermsEqual(terms({ rent: "1750" }), terms({ rent: "1850" }))).toBe(false);
  });
});

describe("firstOfNextMonth", () => {
  it("is when the recurring rent begins", () => {
    expect(firstOfNextMonth("2026-11-15")).toBe("2026-12-01");
    expect(firstOfNextMonth("2026-12-31")).toBe("2027-01-01");
    expect(firstOfNextMonth("2026-11-01")).toBe("2026-12-01");
  });

  it("is empty for something that is not a day", () => {
    expect(firstOfNextMonth("")).toBe("");
  });
});

describe("PDF beside the terms", () => {
  it("reads the four terms from the PDF and flags only a disagreement with the record", () => {
    const p = parse([
      field("leaseStart", "November 15, 2026"),
      field("leaseEnd", "2027-11-14"),
      field("monthlyRent", "$1,850"),
      field("securityDeposit", "$1,750"),
    ]);
    const rows = pdfTermRows(p, terms());
    expect(rows.map((r) => [r.key, r.differs])).toEqual([
      ["leaseStart", false],
      ["leaseEnd", false],
      ["monthlyRent", true],
      ["securityDeposit", false],
    ]);
    expect(rows.find((r) => r.key === "monthlyRent")).toMatchObject({ pdfValue: "$1,850", recordValue: "1750" });
  });

  it("never flags a term the PDF did not state, or stated only ambiguously", () => {
    const p = parse([field("monthlyRent", "", "not_found"), field("leaseStart", "", "ambiguous")]);
    const rows = pdfTermRows(p, terms());
    expect(rows.every((r) => !r.differs)).toBe(true);
    expect(rows.find((r) => r.key === "monthlyRent")?.pdfValue).toBeNull();
  });

  it("does not flag a date written in a form that means two different days", () => {
    const rows = pdfTermRows(parse([field("leaseStart", "03/04/2026")]), terms());
    expect(rows.find((r) => r.key === "leaseStart")?.differs).toBe(false);
  });

  it("an unread PDF compares nothing", () => {
    expect(pdfTermRows(null, terms()).every((r) => r.pdfValue === null && !r.differs)).toBe(true);
  });

  it("tapping the PDF's value moves the record to it", () => {
    const rows = pdfTermRows(parse([field("monthlyRent", "$1,850")]), terms());
    const out = resolvePdfTermPicks(rows, { monthlyRent: "pdf" }, terms());
    expect(out.terms.rent).toBe("1850");
    expect(out.overrides).toEqual({});
    expect(out.unresolved).toEqual([]);
  });

  it("tapping the record's value keeps it and stores it as the manager's reading of the PDF", () => {
    const rows = pdfTermRows(parse([field("monthlyRent", "$1,850")]), terms());
    const out = resolvePdfTermPicks(rows, { monthlyRent: "record" }, terms());
    expect(out.terms.rent).toBe("1750");
    expect(out.overrides).toEqual({ monthlyRent: "$1,750.00" });
  });

  it("an untapped disagreement is unresolved, so Send stays closed", () => {
    const rows = pdfTermRows(parse([field("monthlyRent", "$1,850")]), terms());
    expect(resolvePdfTermPicks(rows, {}, terms()).unresolved).toEqual(["monthlyRent"]);
  });

  it("a human override of the PDF's reading is what is compared", () => {
    const p = parse([field("monthlyRent", "$1,850")], { monthlyRent: "$1,750" });
    expect(pdfTermRows(p, terms()).find((r) => r.key === "monthlyRent")?.differs).toBe(false);
  });
});

describe("term value helpers", () => {
  it("turns the PDF's wording into what the terms card holds", () => {
    expect(termValueFromPdf("leaseStart", "December 1, 2026")).toBe("2026-12-01");
    expect(termValueFromPdf("monthlyRent", "$2,150.00")).toBe("2150");
    expect(termValueFromPdf("leaseStart", "next spring")).toBeNull();
  });

  it("writes a record value the way an override is stored", () => {
    expect(overrideTextForTerm("securityDeposit", "500")).toBe("$500.00");
    expect(overrideTextForTerm("leaseEnd", "2027-01-31")).toBe("2027-01-31");
  });
});
