import { describe, expect, it } from "vitest";
import {
  leaseDocumentFieldLabel,
  normalizeLeaseDocumentField,
  normalizeLeaseDocumentFields,
  newLeaseDocumentFieldId,
  type LeaseDocumentField,
} from "@/lib/lease-document-library";

function field(overrides: Partial<LeaseDocumentField> = {}): LeaseDocumentField {
  return {
    id: "fld_1",
    page: 0,
    x: 0.1,
    y: 0.2,
    w: 0.28,
    h: 0.045,
    role: "resident",
    kind: "signature",
    ...overrides,
  };
}

describe("normalizeLeaseDocumentField", () => {
  it("round-trips a well-formed field", () => {
    const f = field();
    expect(normalizeLeaseDocumentField(f)).toEqual(f);
  });

  it("round-trips every role/kind combination through JSON", () => {
    const roles = ["resident", "manager"] as const;
    const kinds = ["signature", "initials", "date"] as const;
    for (const role of roles) {
      for (const kind of kinds) {
        const f = field({ id: `${role}-${kind}`, role, kind });
        const roundTripped = JSON.parse(JSON.stringify(f));
        expect(normalizeLeaseDocumentField(roundTripped)).toEqual(f);
      }
    }
  });

  it("fails closed on garbage — never invents a value", () => {
    expect(normalizeLeaseDocumentField(null)).toBeNull();
    expect(normalizeLeaseDocumentField("not an object")).toBeNull();
    expect(normalizeLeaseDocumentField(field({ role: "evil" as never }))).toBeNull();
    expect(normalizeLeaseDocumentField(field({ kind: "stamp" as never }))).toBeNull();
    expect(normalizeLeaseDocumentField(field({ page: -1 }))).toBeNull();
    expect(normalizeLeaseDocumentField(field({ page: 1.5 }))).toBeNull();
    expect(normalizeLeaseDocumentField({ ...field(), id: "" })).toBeNull();
    expect(normalizeLeaseDocumentField({ ...field(), id: undefined })).toBeNull();
    expect(normalizeLeaseDocumentField(field({ w: 0 }))).toBeNull();
    expect(normalizeLeaseDocumentField(field({ w: 1.5 }))).toBeNull();
    expect(normalizeLeaseDocumentField(field({ h: -0.1 }))).toBeNull();
    expect(normalizeLeaseDocumentField(field({ x: Number.NaN }))).toBeNull();
    expect(normalizeLeaseDocumentField(field({ x: 5 }))).toBeNull();
  });

  it("tolerates a small out-of-page overhang but not a wild one", () => {
    expect(normalizeLeaseDocumentField(field({ x: -0.1 }))?.x).toBe(-0.1);
    expect(normalizeLeaseDocumentField(field({ x: -0.9 }))).toBeNull();
  });
});

describe("normalizeLeaseDocumentFields", () => {
  it("keeps only the well-formed elements, in order", () => {
    const good = field({ id: "a" });
    const bad = { id: "b", page: -1 };
    const good2 = field({ id: "c", page: 1 });
    expect(normalizeLeaseDocumentFields([good, bad, good2, null, "nope"])).toEqual([good, good2]);
  });

  it("returns an empty array for non-array input", () => {
    expect(normalizeLeaseDocumentFields(null)).toEqual([]);
    expect(normalizeLeaseDocumentFields(undefined)).toEqual([]);
    expect(normalizeLeaseDocumentFields("not an array")).toEqual([]);
    expect(normalizeLeaseDocumentFields({})).toEqual([]);
  });
});

describe("newLeaseDocumentFieldId", () => {
  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newLeaseDocumentFieldId()));
    expect(ids.size).toBe(50);
  });
});

describe("leaseDocumentFieldLabel", () => {
  it("labels every role/kind pair", () => {
    expect(leaseDocumentFieldLabel({ role: "resident", kind: "signature" })).toBe("Resident signature");
    expect(leaseDocumentFieldLabel({ role: "resident", kind: "initials" })).toBe("Resident initials");
    expect(leaseDocumentFieldLabel({ role: "resident", kind: "date" })).toBe("Date signed");
    expect(leaseDocumentFieldLabel({ role: "manager", kind: "signature" })).toBe("Manager signature");
  });
});
