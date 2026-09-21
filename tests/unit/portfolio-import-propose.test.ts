/**
 * Portfolio import — the pure merge of the property/room read and the
 * resident read into one proposal. No model calls, no database: fixtures in,
 * `PortfolioImportProposal` out.
 */
import { describe, expect, it } from "vitest";
import { proposePortfolioImport } from "@/lib/portfolio-import/propose";
import type { PropertyImportUnderstanding } from "@/lib/property-import/types";
import type { UnderstoodResident } from "@/lib/portfolio-import/understand-residents.server";

const UNDERSTANDING: PropertyImportUnderstanding = {
  fileName: "rent-roll.xlsx",
  sourceKind: "xlsx",
  sheets: [{ name: "Rent Roll", whatItIs: "One row per unit", used: true }],
  properties: [
    {
      key: "1-maple",
      name: "Maple Court",
      address: "220 Maple Ave",
      city: "Seattle",
      state: "WA",
      zip: "98103",
      propertyType: "duplex",
      rentByRoom: true,
      bedrooms: 2,
      bathrooms: 2,
      monthlyRent: null,
      deposit: null,
      rooms: [
        { label: "1A", rent: 1850, deposit: 1850, sourceRow: 2 },
        { label: "1B", rent: 1795, deposit: null, sourceRow: 3 },
      ],
      sourceSheet: "Rent Roll",
      sourceRows: [2, 3],
      needsLook: [],
      confidence: "high",
    },
    {
      key: "2-pine",
      name: "1412 Pine St",
      address: "1412 Pine St",
      city: "Seattle",
      state: "WA",
      zip: "98122",
      propertyType: "house",
      rentByRoom: false,
      bedrooms: 3,
      bathrooms: 1.5,
      monthlyRent: 2400,
      deposit: null,
      rooms: [],
      sourceSheet: "Rent Roll",
      sourceRows: [5],
      needsLook: [],
      confidence: "high",
    },
  ],
  summary: ["Two properties."],
  truncatedNote: null,
  rowsRead: 4,
};

const RESIDENTS: UnderstoodResident[] = [
  // 1A: full record, no gaps.
  {
    name: "Riko Tanaka",
    email: "riko@example.com",
    phone: "555-0101",
    roomLabel: "1A",
    sourceSheet: "Rent Roll",
    sourceRows: [2],
    sourcePage: null,
    leaseStart: "2026-01-01",
    leaseEnd: "2026-12-31",
    rent: 1850,
    deposit: 1850,
    balance: null,
  },
  // 1B: no lease end, no contact — gaps expected. Also carries a market-rent-shaped
  // trap the model must have already resolved to the tenant's real rent (1795),
  // never the room's asking figure.
  {
    name: "Sam Lee",
    email: null,
    phone: null,
    roomLabel: "1B",
    sourceSheet: "Rent Roll",
    sourceRows: [3],
    sourcePage: null,
    leaseStart: "2026-02-01",
    leaseEnd: null,
    rent: 1795,
    deposit: null,
    balance: 300,
  },
  // Pine St whole-place resident, no explicit room label (single-room property).
  {
    name: "Jo Rivera",
    email: "jo@example.com",
    phone: null,
    roomLabel: "",
    sourceSheet: "Rent Roll",
    sourceRows: [5],
    sourcePage: null,
    leaseStart: "2026-03-01",
    leaseEnd: "2027-02-28",
    rent: 2400,
    deposit: 2400,
    balance: null,
  },
];

function propose(residents: UnderstoodResident[] = RESIDENTS) {
  return proposePortfolioImport({
    importId: "imp-1",
    files: [{ name: "rent-roll.xlsx", kind: "spreadsheet" }],
    understandings: [UNDERSTANDING],
    residentsByFile: [residents],
  });
}

describe("proposePortfolioImport", () => {
  it("carries every property, room, and resident with its file citation", () => {
    const proposal = propose();
    expect(proposal.importId).toBe("imp-1");
    expect(proposal.properties).toHaveLength(2);

    const maple = proposal.properties.find((p) => p.address === "220 Maple Ave")!;
    expect(maple.rooms).toHaveLength(2);
    expect(maple.rooms[0]!.source).toEqual({ file: "rent-roll.xlsx", sheet: "Rent Roll", rows: [2] });
    expect(maple.residents).toHaveLength(2);
    const riko = maple.residents.find((r) => r.name === "Riko Tanaka")!;
    expect(riko.source).toEqual({ file: "rent-roll.xlsx", sheet: "Rent Roll", rows: [2], page: undefined });
    expect(riko.roomKey).toBe(maple.rooms[0]!.key);
  });

  it("rent is what the tenant pays — never conflated with deposit or balance", () => {
    const proposal = propose();
    const maple = proposal.properties.find((p) => p.address === "220 Maple Ave")!;
    const sam = maple.residents.find((r) => r.name === "Sam Lee")!;
    expect(sam.rent).toBe(1795);
    expect(sam.deposit).toBeNull();
    expect(sam.balance).toBe(300);
    const rentCharge = maple.charges.find((c) => c.residentKey === sam.key && c.kind === "rent")!;
    expect(rentCharge.amount).toBe(1795);
    const balanceCharge = maple.charges.find((c) => c.residentKey === sam.key && c.kind === "balance")!;
    expect(balanceCharge.amount).toBe(300);
    // No deposit charge proposed — the file recorded none for Sam.
    expect(maple.charges.find((c) => c.residentKey === sam.key && c.kind === "deposit")).toBeUndefined();
  });

  it("flags gaps and status 'needs' for a resident missing lease end and contact info", () => {
    const proposal = propose();
    const maple = proposal.properties.find((p) => p.address === "220 Maple Ave")!;
    const sam = maple.residents.find((r) => r.name === "Sam Lee")!;
    expect(sam.status).toBe("needs");
    expect(sam.gaps.map((g) => g.field).sort()).toEqual(["contact", "leaseEnd"]);
    expect(maple.status).toBe("needs");

    const riko = maple.residents.find((r) => r.name === "Riko Tanaka")!;
    expect(riko.status).toBe("ready");
    expect(riko.gaps).toEqual([]);
  });

  it("never fabricates a resident for a room the file shows as unoccupied — that room proposes with no resident", () => {
    const proposal = propose([RESIDENTS[0]!]); // only 1A has a resident
    const maple = proposal.properties.find((p) => p.address === "220 Maple Ave")!;
    expect(maple.rooms).toHaveLength(2); // both rooms still proposed
    expect(maple.residents).toHaveLength(1); // only the occupied one
    expect(maple.residents[0]!.name).toBe("Riko Tanaka");
  });

  it("generates every task kind: missing end date, unsigned lease, move-in photos, missing contact", () => {
    const proposal = propose();
    const maple = proposal.properties.find((p) => p.address === "220 Maple Ave")!;
    const sam = maple.residents.find((r) => r.name === "Sam Lee")!;
    const samTasks = maple.tasks.filter((t) => t.residentKey === sam.key).map((t) => t.kind).sort();
    expect(samTasks).toEqual(["missing_contact", "missing_end_date", "move_in_photos", "unsigned_lease"]);

    const riko = maple.residents.find((r) => r.name === "Riko Tanaka")!;
    const rikoTasks = maple.tasks.filter((t) => t.residentKey === riko.key).map((t) => t.kind).sort();
    // Riko has an end date and contact info, so only the two universal tasks.
    expect(rikoTasks).toEqual(["move_in_photos", "unsigned_lease"]);
  });

  it("attaches a resident with no room label to the whole-place property even though the file names no room", () => {
    const proposal = propose();
    const pine = proposal.properties.find((p) => p.address === "1412 Pine St")!;
    // The file never broke Pine St into rooms — nothing to name, so
    // `create.server.ts` resolves the actual room slot at creation time.
    expect(pine.rooms).toHaveLength(0);
    expect(pine.residents).toHaveLength(1);
    expect(pine.residents[0]!.roomKey).toBeNull();
    expect(pine.residents[0]!.name).toBe("Jo Rivera");
  });

  it("keeps a missing email honest on the proposal (no invented placeholder) when a phone still reaches the resident", () => {
    const noEmail: UnderstoodResident = { ...RESIDENTS[2]!, email: null, phone: "555-0199" };
    const proposal = propose([noEmail]);
    const pine = proposal.properties.find((p) => p.address === "1412 Pine St")!;
    const resident = pine.residents[0]!;
    // The proposal never invents a placeholder for the manager to review —
    // that only happens in create.server.ts, and only if still unanswered.
    expect(resident.email).toBeNull();
    // Has a phone, so contact is not a gap and no missing_contact task fires.
    expect(resident.gaps.find((g) => g.field === "contact")).toBeUndefined();
    expect(pine.tasks.find((t) => t.kind === "missing_contact")).toBeUndefined();
  });

  it("flags missing_contact when the file gives neither an email nor a phone", () => {
    const noContact: UnderstoodResident = { ...RESIDENTS[2]!, email: null, phone: null };
    const proposal = propose([noContact]);
    const pine = proposal.properties.find((p) => p.address === "1412 Pine St")!;
    const resident = pine.residents[0]!;
    expect(resident.status).toBe("needs");
    expect(resident.gaps.find((g) => g.field === "contact")).toBeTruthy();
    expect(pine.tasks.find((t) => t.kind === "missing_contact")).toBeTruthy();
  });

  it("summarizes counts across every property", () => {
    const proposal = propose();
    expect(proposal.summary).toEqual({
      properties: 2,
      rooms: 2,
      residents: 3,
      charges: proposal.properties.flatMap((p) => p.charges).length,
      tasks: proposal.properties.flatMap((p) => p.tasks).length,
      gaps: 2,
    });
  });
});
