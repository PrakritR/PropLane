import { describe, expect, it } from "vitest";

import { detectSheetLayout } from "@/lib/sheet-sync/detect-layout";
import { detectStaysTableColumns, parseStaysTable } from "@/lib/sheet-sync/parse-stays-table";
import { parseCsv } from "@/lib/sheet-sync/csv";

// Shape captured from the captain's own "Stays" tab (BUILD-WAVE2 C210/C213),
// guest names made up for the fixture per the plan's proof note.
const STAYS_CSV = `Property,Room,Guest,Check-in,Check-out,Source,Linen bundle,Early check-in,Late check-out,Baggage storage,Notes
5257 Brooklyn,4,Maya R.,9/24/2026,10/5/2026,Airbnb,Yes,2:00 PM,,,
4709A 8th Ave,5,Leo K.,9/24/2026,12/11/2026,Airbnb,,,,,
4709A 8th Ave,1,Nora P.,9/1/2026,12/31/2026,Tenant,,,,,
5259 Brooklyn,2,Sam T.,9/20/2026,,Tenant,,,,,Move-in inspection pending
,,,,,,,,,,
4709 A 8th Ave,3,Priya S.,9/22/2026,9/28/2026,Direct,,,,,
`;

const OCCUPANCY_CSV = `,,9/22,9/23,9/24
4709A 8th Ave,Room 1,Grace,Grace,Grace
`;

describe("detectStaysTableColumns", () => {
  it("matches the captain's own header labels", () => {
    const rows = parseCsv(STAYS_CSV);
    const map = detectStaysTableColumns(rows[0]!);
    expect(map).toMatchObject({ property: 0, room: 1, guest: 2, checkIn: 3, checkOut: 4, source: 5 });
    expect(map.extras).toEqual([6, 7, 8, 9, 10]);
  });
});

describe("detectSheetLayout", () => {
  it("reads a one-row-per-stay tab as stays", () => {
    expect(detectSheetLayout(parseCsv(STAYS_CSV), "2026-09-24")).toBe("stays");
  });

  it("still reads the existing day-by-day grid as occupancy", () => {
    expect(detectSheetLayout(parseCsv(OCCUPANCY_CSV), "2026-09-24")).toBe("occupancy");
  });

  it("reads an unrecognized tab as unknown", () => {
    expect(detectSheetLayout(parseCsv("Purchase,805912.59\nRENT,6306.51\n"), "2026-09-24")).toBe("unknown");
  });
});

describe("parseStaysTable", () => {
  it("reads every row, importing Tenant and Direct alongside Airbnb (C213)", () => {
    const { stays, skipped } = parseStaysTable(parseCsv(STAYS_CSV), "2026-09-24");
    expect(stays).toHaveLength(5);
    expect(skipped).toBe(0); // the blank spacer row is skipped silently, not counted as bad data
    expect(stays.map((s) => s.channel)).toEqual(["Airbnb", "Airbnb", "Tenant", "Tenant", "Direct"]);
    expect(stays[0]).toMatchObject({
      houseKey: "5257",
      roomNumber: 4,
      name: "Maya R.",
      start: "2026-09-24",
      end: "2026-10-05",
    });
    // An unmatched house spelling ("4709 A 8th Ave" with a space) still keys the same house.
    expect(stays[4]!.houseKey).toBe("4709A");
  });

  it("keeps an open-ended stay (blank check-out) rather than dropping it", () => {
    const { stays } = parseStaysTable(parseCsv(STAYS_CSV), "2026-09-24");
    const samT = stays.find((s) => s.name === "Sam T.");
    expect(samT?.end).toBe("");
    expect(samT?.notes).toContain("Move-in inspection pending");
  });

  it("counts a bad date as skipped rather than importing garbage", () => {
    const badCsv = "Property,Guest,Check-in,Check-out\n5257 Brooklyn,Bad Row,not-a-date,\n";
    const { stays, skipped } = parseStaysTable(parseCsv(badCsv), "2026-09-24");
    expect(stays).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("returns an empty column map (no crash) when no header matches", () => {
    const { stays, columnMap } = parseStaysTable(parseCsv(OCCUPANCY_CSV), "2026-09-24");
    expect(stays).toHaveLength(0);
    expect(columnMap.property).toBeNull();
  });
});
