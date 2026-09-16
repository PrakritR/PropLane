/**
 * Property import — the model's tool call is validated before anyone sees it,
 * and the read refuses to run where it cannot reach a model.
 */
import { describe, expect, it } from "vitest";
import { parseUnderstandingPayload, PropertyImportUnderstandError, understandPropertyImport } from "@/lib/property-import/understand.server";
import { PROPERTY_IMPORT_MAX_PROPERTIES } from "@/lib/property-import/types";

const SOURCE = { fileName: "Copy of Sales.xlsx", kind: "xlsx" as const, rowsRead: 41, truncatedNote: null };

/** What a good read of the Maple Court / Pine St fixtures looks like from the model. */
const RECORDED = {
  sheets: [
    { name: "Summary", whatItIs: "Totals only — no property rows.", used: false },
    { name: "Rent Roll", whatItIs: "One row per unit, grouped by the Address column.", used: true },
  ],
  properties: [
    {
      name: "Maple Court",
      address: "220 Maple Ave",
      city: "Seattle",
      state: "wa",
      zip: "98103",
      propertyType: "duplex",
      rentByRoom: false,
      bedrooms: 4,
      bathrooms: 4,
      monthlyRent: null,
      deposit: null,
      rooms: [
        { label: "1A", rent: 1850, deposit: 1850, sourceRow: 2 },
        { label: "1B", rent: 1795, deposit: 1795, sourceRow: 3 },
        { label: "2A", rent: 1900, deposit: null, sourceRow: 4 },
        { label: "2B", rent: 2100, deposit: 2100, sourceRow: 5 },
      ],
      sourceSheet: "Rent Roll",
      sourceRows: [5, 2, 3, 4],
      needsLook: [],
      confidence: "high",
    },
    {
      name: "1412 Pine St",
      address: "1412 Pine St",
      city: "Seattle",
      state: "WA",
      zip: "98122",
      propertyType: "house",
      rentByRoom: true,
      bedrooms: 3,
      bathrooms: 1.5,
      monthlyRent: null,
      deposit: null,
      rooms: [
        { label: "Room A", rent: 950, deposit: 950, sourceRow: 6 },
        { label: "Room B", rent: 900, deposit: 900, sourceRow: 7 },
        { label: "Room C", rent: null, deposit: null, sourceRow: 8 },
      ],
      sourceSheet: "Rent Roll",
      sourceRows: [6, 7, 8],
      needsLook: ["Room C has no rent in the file"],
      confidence: "medium",
    },
  ],
  summary: ["Two properties on the Rent Roll sheet.", "The Summary sheet was skipped."],
};

describe("parseUnderstandingPayload", () => {
  it("keeps a good read intact, tidies the state and orders the cited rows", () => {
    const out = parseUnderstandingPayload(RECORDED, SOURCE);
    expect(out.fileName).toBe("Copy of Sales.xlsx");
    expect(out.properties).toHaveLength(2);
    expect(out.sheets.map((s) => s.used)).toEqual([false, true]);
    const [maple, pine] = out.properties;
    expect(maple!.state).toBe("WA");
    expect(maple!.sourceRows).toEqual([2, 3, 4, 5]);
    expect(maple!.rooms.map((r) => r.rent)).toEqual([1850, 1795, 1900, 2100]);
    expect(maple!.key).toMatch(/^1-/);
    expect(pine!.rentByRoom).toBe(true);
    expect(pine!.bathrooms).toBe(1.5);
    expect(pine!.needsLook).toEqual(["Room C has no rent in the file"]);
    expect(out.summary).toHaveLength(2);
  });

  it("drops junk: non-positive money, unknown types, rows that are not integers, nameless properties", () => {
    const out = parseUnderstandingPayload(
      {
        sheets: "nope",
        properties: [
          { name: "", address: "", rooms: [] },
          {
            name: "77 S Washington St #4",
            address: "77 S Washington St #4",
            propertyType: "castle",
            rentByRoom: "yes",
            bedrooms: "two",
            bathrooms: -1,
            monthlyRent: -5,
            deposit: 1e9,
            rooms: [{ label: "", rent: 1900.4, deposit: 0, sourceRow: 2.5 }],
            sourceRows: [3, "x", 3, -1],
            needsLook: [42, "check the ZIP"],
            confidence: "sure",
          },
        ],
        summary: null,
      },
      SOURCE,
    );
    expect(out.sheets).toEqual([]);
    expect(out.properties).toHaveLength(1);
    const p = out.properties[0]!;
    expect(p.propertyType).toBe("house");
    expect(p.rentByRoom).toBe(false);
    expect(p.bedrooms).toBe(1);
    expect(p.bathrooms).toBeNull();
    expect(p.monthlyRent).toBeNull();
    expect(p.deposit).toBeNull();
    expect(p.rooms).toEqual([{ label: "Room 1", rent: 1900, deposit: null, sourceRow: null }]);
    expect(p.sourceRows).toEqual([3]);
    expect(p.needsLook).toEqual(["check the ZIP"]);
    expect(p.confidence).toBe("medium");
  });

  it("caps the property count", () => {
    const many = Array.from({ length: PROPERTY_IMPORT_MAX_PROPERTIES + 5 }, (_, i) => ({ name: `${i} Main St`, address: `${i} Main St`, rooms: [] }));
    expect(parseUnderstandingPayload({ properties: many }, SOURCE).properties).toHaveLength(PROPERTY_IMPORT_MAX_PROPERTIES);
  });
});

describe("understandPropertyImport", () => {
  it("refuses to run under test / without a key rather than inventing a portfolio", async () => {
    await expect(
      understandPropertyImport({
        source: { kind: "csv", fileName: "x.csv", sheets: [{ name: "Sheet1", rows: [{ row: 1, cells: ["Address"] }] }], pages: [], rowsRead: 1, truncatedNote: null },
        actor: { userId: "mgr-1" },
      }),
    ).rejects.toBeInstanceOf(PropertyImportUnderstandError);
  });
});
