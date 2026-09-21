/**
 * Portfolio import — proves the rebuild against the REAL fixture bytes, not
 * hand-built understanding objects (`portfolio-import-propose.test.ts` covers
 * the pure merge in isolation). This suite drives the actual file reader
 * (`read-file.server.ts`) on every fixture on disk, then the two real model
 * passes (`understand.server.ts`, `understand-residents.server.ts`) with only
 * the Anthropic call mocked, then the real pure merge (`propose.ts`) — and
 * checks the fixture's own facts survive: every citation points at a real
 * row/page, the resident/property counts match what is actually in the file,
 * rent is never the market/asking figure sitting in the next column, and a
 * resident the file gives no email for keeps `email: null` rather than one
 * being invented.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportPropertyProposal, ImportSource } from "@/lib/portfolio-import/types";
import type { PropertyImportUnderstanding } from "@/lib/property-import/types";
import type { UnderstoodResident } from "@/lib/portfolio-import/understand-residents.server";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));
// Bypass the real Langfuse client entirely rather than letting it decide
// whether to init off a flipped NODE_ENV — same pattern as
// tests/unit/listing-prefill-route.test.ts.
vi.mock("@/lib/observability/langfuse", () => ({
  traceAgentTurn: async (_actor: unknown, _messages: unknown, run: (observer?: unknown) => Promise<unknown>) => run(),
}));

// vi.mock calls above are hoisted above these imports by vitest.
import { readPropertyImportFile } from "@/lib/property-import/read-file.server";
import { understandPropertyImport } from "@/lib/property-import/understand.server";
import { understandResidents } from "@/lib/portfolio-import/understand-residents.server";
import { proposePortfolioImport } from "@/lib/portfolio-import/propose";

const FIXTURES = path.join(process.cwd(), "tests/fixtures/portfolio-import");
const bytes = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));
const ACTOR = { userId: "mgr-1" };

/** Routes the mocked Anthropic response by which tool the caller forced. */
function mockModel(propertiesInput: unknown, residentsInput: unknown) {
  create.mockImplementation(async (params: { tool_choice: { name: string } }) => {
    const name = params.tool_choice.name;
    const input = name === "report_properties" ? propertiesInput : residentsInput;
    return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name, input }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  });
}

let prevNodeEnv: string | undefined;
let prevApiKey: string | undefined;

beforeEach(() => {
  create.mockReset();
  prevNodeEnv = process.env.NODE_ENV;
  prevApiKey = process.env.ANTHROPIC_API_KEY;
  // Both real model-call functions refuse under NODE_ENV=test or without a
  // key rather than inventing a portfolio (see their own tests) — flip both
  // for the duration of the call so the real (mocked) call path runs.
  process.env.NODE_ENV = "development";
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  process.env.NODE_ENV = prevNodeEnv;
  if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevApiKey;
});

/** Every resident, room and charge in a proposal cites a real row or page. */
function citesSource(source: ImportSource): boolean {
  return (source.rows?.length ?? 0) > 0 || source.page != null;
}

function assertEveryCitationIsReal(properties: ImportPropertyProposal[]) {
  for (const property of properties) {
    expect(citesSource(property.source), `property ${property.address} cites a row`).toBe(true);
    for (const room of property.rooms) expect(citesSource(room.source), `room ${room.name} cites a row`).toBe(true);
    for (const resident of property.residents) expect(citesSource(resident.source), `resident ${resident.name} cites a row`).toBe(true);
    for (const charge of property.charges) expect(citesSource(charge.source), `charge ${charge.key} cites a row`).toBe(true);
  }
}

async function runPipeline(fileName: string, propertiesInput: unknown, residentsInput: unknown) {
  const source = await readPropertyImportFile({ bytes: bytes(fileName), fileName, mediaType: "" });
  mockModel(propertiesInput, residentsInput);
  const understanding: PropertyImportUnderstanding = await understandPropertyImport({ source, actor: ACTOR });
  const residents: UnderstoodResident[] = await understandResidents({ source, actor: ACTOR });
  const proposal = proposePortfolioImport({
    importId: "import-1",
    files: [{ name: fileName, kind: "spreadsheet" }],
    understandings: [understanding],
    residentsByFile: [residents],
  });
  return { source, understanding, residents, proposal };
}

describe("portfolio import over real fixtures", () => {
  it("appfolio-rent-roll.csv — 2 properties, 5 current residents, tenant rent kept, gaps left honest", async () => {
    const propertiesInput = {
      sheets: [{ name: "Sheet1", whatItIs: "One row per unit, grouped by the Property column.", used: true }],
      properties: [
        {
          name: "Maple Court",
          address: "220 Maple Ave",
          city: "Seattle",
          state: "WA",
          zip: "98103",
          propertyType: "duplex",
          rentByRoom: true,
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
          sourceSheet: "Sheet1",
          sourceRows: [2, 3, 4, 5],
          needsLook: [],
          confidence: "high",
        },
        {
          name: "1412 Pine St",
          address: "1412 Pine St",
          city: "Seattle",
          state: "WA",
          zip: "98101",
          propertyType: "house",
          rentByRoom: true,
          bedrooms: 3,
          bathrooms: 1.5,
          monthlyRent: null,
          deposit: null,
          rooms: [
            { label: "Room 1", rent: 950, deposit: 950, sourceRow: 6 },
            { label: "Room 2", rent: 925, deposit: null, sourceRow: 7 },
            { label: "Room 3", rent: 975, deposit: 975, sourceRow: 8 },
          ],
          sourceSheet: "Sheet1",
          sourceRows: [6, 7, 8],
          needsLook: [],
          confidence: "high",
        },
      ],
      summary: ["Two properties on the one sheet."],
    };
    const residentsInput = {
      residents: [
        { name: "Dana Whitfield", email: "dana.w@gmail.com", phone: "(206) 555-0134", roomLabel: "1A", sourceSheet: "Sheet1", sourceRows: [2], sourcePage: null, leaseStart: "2026-03-01", leaseEnd: "2027-02-28", rent: 1850, deposit: 1850, balance: null },
        { name: "Marcus Bell", email: "mbell@outlook.com", phone: "(206) 555-0177", roomLabel: "1B", sourceSheet: "Sheet1", sourceRows: [3], sourcePage: null, leaseStart: "2025-11-15", leaseEnd: "2026-11-14", rent: 1795, deposit: 1795, balance: 350 },
        { name: "Priya Nair & Tom Ellis", email: "priya.nair@me.com", phone: "(425) 555-0190", roomLabel: "2B", sourceSheet: "Sheet1", sourceRows: [5], sourcePage: null, leaseStart: "2026-06-01", leaseEnd: "2027-05-31", rent: 2100, deposit: 2100, balance: null },
        // Blank "Lease To" cell in the file — leaseEnd stays null, never a guessed one-year term.
        { name: "Jae Park", email: "jae.park@proton.me", phone: "(206) 555-0102", roomLabel: "Room 1", sourceSheet: "Sheet1", sourceRows: [6], sourcePage: null, leaseStart: "2026-01-01", leaseEnd: null, rent: 950, deposit: 950, balance: null },
        // Blank "Email" cell in the file.
        { name: "Luis Ortega", email: null, phone: "(206) 555-0166", roomLabel: "Room 3", sourceSheet: "Sheet1", sourceRows: [8], sourcePage: null, leaseStart: "2025-11-01", leaseEnd: "2026-10-31", rent: 975, deposit: 975, balance: null },
      ],
    };

    const { proposal } = await runPipeline("appfolio-rent-roll.csv", propertiesInput, residentsInput);

    // Ground truth counted directly from the fixture: 2 property blocks
    // (Maple Court rows 2-5, 1412 Pine St rows 6-8), 5 occupied rows (2A and
    // Pine's Room 2 are "Vacant" and never become residents).
    expect(proposal.summary.properties).toBe(2);
    expect(proposal.summary.residents).toBe(5);
    assertEveryCitationIsReal(proposal.properties);

    const allResidents = proposal.properties.flatMap((p) => p.residents);
    const luis = allResidents.find((r) => r.name === "Luis Ortega")!;
    expect(luis.email).toBeNull(); // honest gap, never a made-up address
    expect(luis.rent).toBe(975);

    const jae = allResidents.find((r) => r.name === "Jae Park")!;
    expect(jae.leaseEnd).toBeNull();
    expect(jae.status).toBe("needs");
    expect(jae.gaps.map((g) => g.field)).toContain("leaseEnd");

    const marcus = allResidents.find((r) => r.name === "Marcus Bell")!;
    expect(marcus.balance).toBe(350);
    const marcusCharges = proposal.properties.flatMap((p) => p.charges).filter((c) => c.residentKey === marcus.key);
    expect(marcusCharges.map((c) => c.kind).sort()).toEqual(["balance", "deposit", "rent"]);
  });

  it("generic.csv — same underlying rent roll under an owner's own column names, same counts", async () => {
    // Identical row-for-row content to the AppFolio export, just generic
    // headers (Bldg/Occupant/Owed instead of Property/Tenant/Past Due).
    const propertiesInput = {
      sheets: [{ name: "Sheet1", whatItIs: "One row per unit.", used: true }],
      properties: [
        {
          name: "Maple Court",
          address: "220 Maple Ave",
          city: "Seattle",
          state: "WA",
          zip: "98103",
          propertyType: "duplex",
          rentByRoom: true,
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
          sourceSheet: "Sheet1",
          sourceRows: [2, 3, 4, 5],
          needsLook: [],
          confidence: "high",
        },
        {
          name: "1412 Pine St",
          address: "1412 Pine St",
          city: "Seattle",
          state: "WA",
          zip: "98101",
          propertyType: "house",
          rentByRoom: true,
          bedrooms: 3,
          bathrooms: 1.5,
          monthlyRent: null,
          deposit: null,
          rooms: [
            { label: "Room 1", rent: 950, deposit: 950, sourceRow: 6 },
            { label: "Room 2", rent: 925, deposit: null, sourceRow: 7 },
            { label: "Room 3", rent: 975, deposit: 975, sourceRow: 8 },
          ],
          sourceSheet: "Sheet1",
          sourceRows: [6, 7, 8],
          needsLook: [],
          confidence: "high",
        },
      ],
      summary: ["Two properties."],
    };
    const residentsInput = {
      residents: [
        { name: "Dana Whitfield", email: "dana.w@gmail.com", phone: "(206) 555-0134", roomLabel: "1A", sourceSheet: "Sheet1", sourceRows: [2], sourcePage: null, leaseStart: "2026-03-01", leaseEnd: "2027-02-28", rent: 1850, deposit: 1850, balance: null },
        { name: "Marcus Bell", email: "mbell@outlook.com", phone: "(206) 555-0177", roomLabel: "1B", sourceSheet: "Sheet1", sourceRows: [3], sourcePage: null, leaseStart: "2025-11-15", leaseEnd: "2026-11-14", rent: 1795, deposit: 1795, balance: 350 },
        { name: "Priya Nair & Tom Ellis", email: "priya.nair@me.com", phone: "(425) 555-0190", roomLabel: "2B", sourceSheet: "Sheet1", sourceRows: [5], sourcePage: null, leaseStart: "2026-06-01", leaseEnd: "2027-05-31", rent: 2100, deposit: 2100, balance: null },
        { name: "Jae Park", email: "jae.park@proton.me", phone: "(206) 555-0102", roomLabel: "Room 1", sourceSheet: "Sheet1", sourceRows: [6], sourcePage: null, leaseStart: "2026-01-01", leaseEnd: null, rent: 950, deposit: 950, balance: null },
        { name: "Luis Ortega", email: null, phone: "(206) 555-0166", roomLabel: "Room 3", sourceSheet: "Sheet1", sourceRows: [8], sourcePage: null, leaseStart: "2025-11-01", leaseEnd: "2026-10-31", rent: 975, deposit: 975, balance: null },
      ],
    };

    const { proposal } = await runPipeline("generic.csv", propertiesInput, residentsInput);

    expect(proposal.summary.properties).toBe(2);
    expect(proposal.summary.residents).toBe(5);
    assertEveryCitationIsReal(proposal.properties);
  });

  it("buildium-rent-roll.xlsx — Market Rent sits right next to Monthly Rent; the proposal keeps the tenant's figure", async () => {
    const propertiesInput = {
      sheets: [
        { name: "Summary", whatItIs: "Totals only.", used: false },
        { name: "Rent Roll", whatItIs: "One row per unit.", used: true },
      ],
      properties: [
        {
          name: "Maple Court",
          address: "220 Maple Ave",
          city: "Seattle",
          state: "WA",
          zip: "98103",
          propertyType: "duplex",
          rentByRoom: true,
          bedrooms: 4,
          bathrooms: 4,
          monthlyRent: null,
          deposit: null,
          // Rent column kept (1850/1795/1900/2100), never the adjacent Market Rent column (1975/1895/1975/2195).
          rooms: [
            { label: "1A", rent: 1850, deposit: 1850, sourceRow: 2 },
            { label: "1B", rent: 1795, deposit: 1795, sourceRow: 3 },
            { label: "2A", rent: 1900, deposit: null, sourceRow: 4 },
            { label: "2B", rent: 2100, deposit: 2100, sourceRow: 5 },
          ],
          sourceSheet: "Rent Roll",
          sourceRows: [2, 3, 4, 5],
          needsLook: [],
          confidence: "high",
        },
        {
          name: "1412 Pine St",
          address: "1412 Pine St",
          city: "Seattle",
          state: "WA",
          zip: "98101",
          propertyType: "house",
          rentByRoom: true,
          bedrooms: 3,
          bathrooms: 1.5,
          monthlyRent: null,
          deposit: null,
          rooms: [
            { label: "Room 1", rent: 950, deposit: 950, sourceRow: 6 },
            { label: "Room 2", rent: 925, deposit: null, sourceRow: 7 },
            { label: "Room 3", rent: 975, deposit: 975, sourceRow: 8 },
          ],
          sourceSheet: "Rent Roll",
          sourceRows: [6, 7, 8],
          needsLook: [],
          confidence: "high",
        },
      ],
      summary: ["Two properties; a Summary sheet with totals only was skipped."],
    };
    const residentsInput = {
      residents: [
        { name: "Dana Whitfield", email: "dana.w@gmail.com", phone: "(206) 555-0134", roomLabel: "1A", sourceSheet: "Rent Roll", sourceRows: [2], sourcePage: null, leaseStart: "2026-03-01", leaseEnd: "2027-02-28", rent: 1850, deposit: 1850, balance: null },
        { name: "Marcus Bell", email: "mbell@outlook.com", phone: "(206) 555-0177", roomLabel: "1B", sourceSheet: "Rent Roll", sourceRows: [3], sourcePage: null, leaseStart: "2025-11-15", leaseEnd: "2026-11-14", rent: 1795, deposit: 1795, balance: 350 },
        { name: "Priya Nair & Tom Ellis", email: "priya.nair@me.com", phone: "(425) 555-0190", roomLabel: "2B", sourceSheet: "Rent Roll", sourceRows: [5], sourcePage: null, leaseStart: "2026-06-01", leaseEnd: "2027-05-31", rent: 2100, deposit: 2100, balance: null },
        { name: "Jae Park", email: "jae.park@proton.me", phone: "(206) 555-0102", roomLabel: "Room 1", sourceSheet: "Rent Roll", sourceRows: [6], sourcePage: null, leaseStart: "2026-01-01", leaseEnd: null, rent: 950, deposit: 950, balance: null },
        { name: "Luis Ortega", email: null, phone: "(206) 555-0166", roomLabel: "Room 3", sourceSheet: "Rent Roll", sourceRows: [8], sourcePage: null, leaseStart: "2025-11-01", leaseEnd: "2026-10-31", rent: 975, deposit: 975, balance: null },
      ],
    };

    const { source, proposal } = await runPipeline("buildium-rent-roll.xlsx", propertiesInput, residentsInput);

    // The real reader actually saw both columns — prove the trap is real,
    // not assumed: row 2 (Dana) has 1850 in one cell and 1975 in another.
    const row2 = source.sheets.find((s) => s.name === "Rent Roll")!.rows.find((r) => r.row === 2)!;
    expect(row2.cells).toContain("1850");
    expect(row2.cells).toContain("1975");

    expect(proposal.summary.properties).toBe(2);
    expect(proposal.summary.residents).toBe(5);
    assertEveryCitationIsReal(proposal.properties);

    const dana = proposal.properties.flatMap((p) => p.residents).find((r) => r.name === "Dana Whitfield")!;
    expect(dana.rent).toBe(1850);
    expect(dana.rent).not.toBe(1975); // never the Market Rent column
    const room1A = proposal.properties.flatMap((p) => p.rooms).find((r) => r.name === "1A")!;
    expect(room1A.rent).toBe(1850);
    expect(room1A.rent).not.toBe(1975);
  });

  it("rent-roll.pdf — same rent roll as text; residents cite a page and a line, never a row-less guess", async () => {
    const propertiesInput = {
      sheets: [{ name: "Document", whatItIs: "Page text, one line per unit.", used: true }],
      properties: [
        {
          name: "Maple Court",
          address: "220 Maple Ave",
          city: "Seattle",
          state: "WA",
          zip: "98103",
          propertyType: "duplex",
          rentByRoom: true,
          bedrooms: 4,
          bathrooms: 4,
          monthlyRent: null,
          deposit: null,
          rooms: [
            { label: "1A", rent: 1850, deposit: 1850, sourceRow: 3 },
            { label: "1B", rent: 1795, deposit: 1795, sourceRow: 4 },
            { label: "2A", rent: 1900, deposit: null, sourceRow: 5 },
            { label: "2B", rent: 2100, deposit: 2100, sourceRow: 6 },
          ],
          sourceSheet: "Document",
          sourceRows: [2, 3, 4, 5, 6],
          needsLook: [],
          confidence: "high",
        },
        {
          name: "1412 Pine St",
          address: "1412 Pine St",
          city: "Seattle",
          state: "WA",
          zip: "98101",
          propertyType: "house",
          rentByRoom: true,
          bedrooms: 3,
          bathrooms: 1.5,
          monthlyRent: null,
          deposit: null,
          rooms: [
            { label: "Room 1", rent: 950, deposit: 950, sourceRow: 8 },
            { label: "Room 2", rent: 925, deposit: null, sourceRow: 9 },
            { label: "Room 3", rent: 975, deposit: 975, sourceRow: 10 },
          ],
          sourceSheet: "Document",
          sourceRows: [7, 8, 9, 10],
          needsLook: [],
          confidence: "high",
        },
      ],
      summary: ["Two properties read from page text."],
    };
    const residentsInput = {
      residents: [
        { name: "Dana Whitfield", email: "dana.w@gmail.com", phone: "(206) 555-0134", roomLabel: "1A", sourceSheet: "Document", sourceRows: [3], sourcePage: 1, leaseStart: "2026-03-01", leaseEnd: "2027-02-28", rent: 1850, deposit: 1850, balance: null },
        { name: "Marcus Bell", email: "mbell@outlook.com", phone: "(206) 555-0177", roomLabel: "1B", sourceSheet: "Document", sourceRows: [4], sourcePage: 1, leaseStart: "2025-11-15", leaseEnd: "2026-11-14", rent: 1795, deposit: 1795, balance: 350 },
        { name: "Priya Nair & Tom Ellis", email: "priya.nair@me.com", phone: "(425) 555-0190", roomLabel: "2B", sourceSheet: "Document", sourceRows: [6], sourcePage: 1, leaseStart: "2026-06-01", leaseEnd: "2027-05-31", rent: 2100, deposit: 2100, balance: null },
        // "month-to-month" in the text — no end date, never a guessed term.
        { name: "Jae Park", email: "jae.park@proton.me", phone: "(206) 555-0102", roomLabel: "Room 1", sourceSheet: "Document", sourceRows: [8], sourcePage: 1, leaseStart: "2026-01-01", leaseEnd: null, rent: 950, deposit: 950, balance: null },
        // No email printed for Luis on the page — only a phone.
        { name: "Luis Ortega", email: null, phone: "(206) 555-0166", roomLabel: "Room 3", sourceSheet: "Document", sourceRows: [10], sourcePage: 1, leaseStart: "2025-11-01", leaseEnd: "2026-10-31", rent: 975, deposit: 975, balance: null },
      ],
    };

    const { source, proposal } = await runPipeline("rent-roll.pdf", propertiesInput, residentsInput);

    expect(source.kind).toBe("pdf");
    expect(proposal.summary.properties).toBe(2);
    expect(proposal.summary.residents).toBe(5);
    assertEveryCitationIsReal(proposal.properties);

    const allResidents = proposal.properties.flatMap((p) => p.residents);
    for (const resident of allResidents) {
      // Every pdf-sourced resident cites the page it came from, not just a row.
      expect(resident.source.page).toBe(1);
      expect(resident.source.rows?.length).toBeGreaterThan(0);
    }
    const luis = allResidents.find((r) => r.name === "Luis Ortega")!;
    expect(luis.email).toBeNull();
  });

  it("owner-messy.xlsx — 4 properties from an owner's own sheet with no tenant names, so zero residents (never invented)", async () => {
    // Houses: two addresses grouped by a merged House column, room rows below
    // each carry Market Rent AND Rent — the trap repeats here too.
    // Condos: two standalone whole-place units, no rooms breakdown needed.
    // Neither sheet names a single tenant anywhere.
    const propertiesInput = {
      sheets: [
        { name: "Houses", whatItIs: "One row per room, addresses grouped.", used: true },
        { name: "Condos", whatItIs: "One row per whole-place condo.", used: true },
        { name: "Summary", whatItIs: "Portfolio totals only.", used: false },
      ],
      properties: [
        {
          name: "400 Pike Street",
          address: "400 Pike Street",
          city: "Seattle",
          state: "WA",
          zip: "98101",
          propertyType: "house",
          rentByRoom: true,
          bedrooms: 4,
          bathrooms: 2,
          monthlyRent: null,
          deposit: null,
          rooms: [
            { label: "A", rent: 1050, deposit: 1050, sourceRow: 4 },
            { label: "B", rent: 975, deposit: 975, sourceRow: 5 },
            { label: "C", rent: 925, deposit: 925, sourceRow: 6 },
            { label: "D", rent: 950, deposit: 950, sourceRow: 7 },
          ],
          sourceSheet: "Houses",
          sourceRows: [4, 5, 6, 7],
          needsLook: [],
          confidence: "high",
        },
        {
          name: "5031 Brooklyn Ave NE",
          address: "5031 Brooklyn Ave NE",
          city: "Seattle",
          state: "WA",
          zip: "98105",
          propertyType: "house",
          rentByRoom: true,
          bedrooms: 5,
          bathrooms: 2,
          monthlyRent: null,
          deposit: null,
          rooms: [
            { label: "1", rent: 950, deposit: 950, sourceRow: 9 },
            { label: "2", rent: 950, deposit: 950, sourceRow: 10 },
            { label: "3", rent: 975, deposit: 975, sourceRow: 11 },
            { label: "4", rent: 925, deposit: 925, sourceRow: 12 },
            { label: "5", rent: 950, deposit: 950, sourceRow: 13 },
          ],
          sourceSheet: "Houses",
          sourceRows: [9, 10, 11, 12, 13],
          needsLook: [],
          confidence: "high",
        },
        {
          name: "918 Harvard Ave E",
          address: "918 Harvard Ave E",
          city: "Seattle",
          state: "WA",
          zip: "",
          propertyType: "condo",
          rentByRoom: false,
          bedrooms: 2,
          bathrooms: 1,
          monthlyRent: 2650,
          deposit: 2650,
          rooms: [{ label: "Unit", rent: 2650, deposit: 2650, sourceRow: 4 }],
          sourceSheet: "Condos",
          sourceRows: [4],
          needsLook: ["No ZIP code in the file for this condo"],
          confidence: "medium",
        },
        {
          name: "77 S Washington St #4",
          address: "77 S Washington St #4",
          city: "Seattle",
          state: "WA",
          zip: "98104",
          propertyType: "condo",
          rentByRoom: false,
          bedrooms: 1,
          bathrooms: 1,
          monthlyRent: 1900,
          deposit: 1900,
          rooms: [{ label: "Unit", rent: 1900, deposit: 1900, sourceRow: 5 }],
          sourceSheet: "Condos",
          sourceRows: [5],
          needsLook: [],
          confidence: "high",
        },
      ],
      summary: ["Two houses let by the room, two whole-place condos.", "The Summary sheet is totals only and was skipped."],
    };
    // The owner's sheet never names who lives in any room — just rent per
    // unit. A correct read reports zero residents rather than guessing one
    // per room.
    const residentsInput = { residents: [] };

    const { source, proposal } = await runPipeline("owner-messy.xlsx", propertiesInput, residentsInput);

    // Prove the Market-Rent-beside-Rent trap is real in this fixture too.
    const housesSheet = source.sheets.find((s) => s.name === "Houses")!;
    const row4 = housesSheet.rows.find((r) => r.row === 4)!;
    expect(row4.cells).toContain("1150"); // Market Rent
    expect(row4.cells).toContain("1050"); // Rent — what room A's proposal must carry

    // Ground truth counted directly from the fixture: 4 property blocks
    // (400 Pike Street rows 4-7, 5031 Brooklyn Ave NE rows 9-13, and two
    // standalone Condos rows), 11 rooms, 0 named residents anywhere.
    expect(proposal.summary.properties).toBe(4);
    expect(proposal.summary.rooms).toBe(11);
    expect(proposal.summary.residents).toBe(0);
    expect(proposal.summary.charges).toBe(0);
    assertEveryCitationIsReal(proposal.properties);

    const pike = proposal.properties.find((p) => p.address === "400 Pike Street")!;
    expect(pike.rooms.find((r) => r.name === "A")!.rent).toBe(1050);
    expect(pike.rooms.find((r) => r.name === "A")!.rent).not.toBe(1150);
    expect(pike.residents).toHaveLength(0);
  });
});
