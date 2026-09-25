import { describe, expect, it } from "vitest";
import {
  parseResidentDocumentKindFilter,
  parseResidentDocumentTab,
  residentDocumentTabForApplication,
  residentDocumentTabForLease,
  residentDocumentTabForOther,
  residentDocumentTabForReceipt,
  RESIDENT_DOCUMENT_KIND_DEFAULT_TAB,
  RESIDENT_DOCUMENT_TAB_LABELS,
  RESIDENT_DOCUMENT_TAB_ORDER,
} from "@/lib/resident-documents-tabs";

describe("residentDocumentTabForApplication", () => {
  it("buckets a pending application as to-sign", () => {
    expect(residentDocumentTabForApplication("pending")).toBe("to-sign");
  });

  it("buckets a settled application (approved or rejected) as archived", () => {
    expect(residentDocumentTabForApplication("approved")).toBe("archived");
    expect(residentDocumentTabForApplication("rejected")).toBe("archived");
  });
});

describe("residentDocumentTabForLease", () => {
  it("buckets a pending (unsigned) lease as to-sign", () => {
    expect(residentDocumentTabForLease({ filterBucket: "pending" })).toBe("to-sign");
  });

  it("buckets a signed lease (current or a prior renewal snapshot) as signed", () => {
    expect(residentDocumentTabForLease({ filterBucket: "signed" })).toBe("signed");
  });
});

describe("receipts and other documents", () => {
  it("are always archived — neither carries a signature workflow", () => {
    expect(residentDocumentTabForReceipt()).toBe("archived");
    expect(residentDocumentTabForOther()).toBe("archived");
  });
});

describe("parseResidentDocumentTab", () => {
  it("accepts every real bucket id", () => {
    for (const id of RESIDENT_DOCUMENT_TAB_ORDER) {
      expect(parseResidentDocumentTab(id)).toBe(id);
    }
  });

  it("falls back to to-sign for garbage or missing input", () => {
    expect(parseResidentDocumentTab("bogus")).toBe("to-sign");
    expect(parseResidentDocumentTab(undefined)).toBe("to-sign");
  });

  it("has a label for every bucket", () => {
    for (const id of RESIDENT_DOCUMENT_TAB_ORDER) {
      expect(RESIDENT_DOCUMENT_TAB_LABELS[id]).toBeTruthy();
    }
  });
});

describe("parseResidentDocumentKindFilter", () => {
  it("accepts every real legacy kind and rejects everything else", () => {
    expect(parseResidentDocumentKindFilter("application")).toBe("application");
    expect(parseResidentDocumentKindFilter("lease")).toBe("lease");
    expect(parseResidentDocumentKindFilter("receipts")).toBe("receipts");
    expect(parseResidentDocumentKindFilter("other")).toBe("other");
    expect(parseResidentDocumentKindFilter("bogus")).toBeNull();
    expect(parseResidentDocumentKindFilter(undefined)).toBeNull();
  });
});

describe("RESIDENT_DOCUMENT_KIND_DEFAULT_TAB", () => {
  it("gives every legacy kind a real bucket to land a bare list URL on", () => {
    for (const [kind, tab] of Object.entries(RESIDENT_DOCUMENT_KIND_DEFAULT_TAB)) {
      expect(RESIDENT_DOCUMENT_TAB_ORDER).toContain(tab);
      expect(typeof kind).toBe("string");
    }
  });
});
