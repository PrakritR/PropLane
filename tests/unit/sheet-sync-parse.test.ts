import { describe, expect, it } from "vitest";

import { isLockedLiveListingId } from "@/lib/ambika-seattle-occupancy";
import { parseCsv } from "@/lib/sheet-sync/csv";
import { exclusiveCheckoutAfterLastNight, parseMoneyDollars, parseSheetDate } from "@/lib/sheet-sync/dates";
import { inferHouseKey, listingMatchesHouseKey, namesOverlap, parseRoomNumber } from "@/lib/sheet-sync/house-key";
import { accessNotes, parseHouseTab } from "@/lib/sheet-sync/parse-house-tab";
import { parseOccupancyGrid, parseOccupancyGuest } from "@/lib/sheet-sync/parse-occupancy";
import { parseSpreadsheetUrl } from "@/lib/sheet-sync/url";
import {
  ALL_SHEET_PROPERTIES,
  AMBIKA_OCCUPANCY_GID,
  AMBIKA_SALES_SPREADSHEET_ID,
  normalizeManagerSheetBinding,
  normalizeManagerSheetBindings,
  normalizeManagerSheetLink,
  sheetBindingAppliesToProperty,
  sheetLinkFromUrl,
  suggestedSpreadsheetUrlForEmail,
  type ManagerSheetBinding,
} from "@/lib/manager-sheet-link";
import { assertWritableSheetPropertyId, filterSheetPropertyMap, resolveSheetPropertyId } from "@/lib/sheet-sync/match";

const OCCUPANCY_CSV = `,,9/22,9/23,9/24,9/25,9/26,9/27,9/28,9/29,9/30
4709A 8th Ave,Room 1,Grace,Grace,Grace,Grace,Grace,Grace,Grace,Grace,Grace
,Room 2,Sohan,Sohan,Sohan,Sohan,Sohan,Sohan,Sohan,Sohan,Sohan
,Room 3,Airbnb Ved,Airbnb Ved,Airbnb Ved,Airbnb Ved,Airbnb Ved,Airbnb Ved,Airbnb Ved,Airbnb Ved,Airbnb Ved
,Room 4,Vinod Booking,Vinod Booking,Vinod Booking,Vinod Booking,Vinod Booking,Vinod Booking,Vinod Booking,Vinod Booking,Vinod Booking
,Room 5,Aaron,Aaron,Aaron,Aaron,Aaron,Aaron,Aaron,Aaron,Aaron
5259 Brooklyn,Room 2,Fekadu,Fekadu,Fekadu,Fekadu,Fekadu,Fekadu,Fekadu,Fekadu,Fekadu
5257 Brooklyn,Room 1,Heesu,Heesu,Heesu,Heesu,Heesu,Heesu,Heesu,Heesu,Heesu
,Room 4,Airbnb Chinese,Airbnb Rae,Airbnb Rae,Airbnb Rae,,,,,,
,Room 5,,Airbnb Daiyun,,,,,,,,
`;

const HOUSE_CSV = `Purchase,805912.59,Front Gate Code,07575
RENT,6306.51,House Code,75000
,,Back Gate Code,7501
,,Pantry Code,9752
,,Backup Lockbox Code,56303
Room,Name,Phone,Rent,Utilities,Lease start,Lease End,Door Code
Room 1,Heesu,(360) 890-1924,850,150,,,
Room 2,Alexander,(206) 599-0085,800,130,,9/30/2026,
Room 3,Akshaya,(425) 890-0021,900,,,,
Room 4,Airbnb,,,,,,,
Room 8,Riko,(206) 327-5264,850,150,,Month to month,
`;

const EIGHTH_CSV = `,,,,,,,,,,,,,,Room,Name,Phone,Rent,Utilities,Door Code
,,,,,,,,,,,,,,Room 1,Grace Natalie Halverson,(715) 419-2818,725,150,8916566666
,,,,,,,,,,,,,,Room 2,Sohan Vivek Naik,,,0,,
`;

describe("sheet URL + link", () => {
  it("reads the Sales workbook id and Residents gid", () => {
    const parsed = parseSpreadsheetUrl(
      `https://docs.google.com/spreadsheets/d/${AMBIKA_SALES_SPREADSHEET_ID}/edit?gid=${AMBIKA_OCCUPANCY_GID}#gid=${AMBIKA_OCCUPANCY_GID}`,
    );
    expect(parsed).toEqual({
      spreadsheetId: AMBIKA_SALES_SPREADSHEET_ID,
      gid: AMBIKA_OCCUPANCY_GID,
      url: expect.stringContaining(AMBIKA_SALES_SPREADSHEET_ID),
    });
  });

  it("suggests Ambika's Sales workbook for her email only", () => {
    expect(suggestedSpreadsheetUrlForEmail("ogambik2@gmail.com")).toContain(AMBIKA_SALES_SPREADSHEET_ID);
    expect(suggestedSpreadsheetUrlForEmail("someone@else.com")).toBeNull();
  });

  it("stores a pasted URL on the account link", () => {
    const link = sheetLinkFromUrl(
      `https://docs.google.com/spreadsheets/d/${AMBIKA_SALES_SPREADSHEET_ID}/edit?gid=${AMBIKA_OCCUPANCY_GID}`,
    );
    expect(normalizeManagerSheetLink(link).spreadsheetId).toBe(AMBIKA_SALES_SPREADSHEET_ID);
    expect(link.occupancyGid).toBe(AMBIKA_OCCUPANCY_GID);
    expect(link.autoSync).toBe(true);
  });
});

describe("sheet bindings", () => {
  const sales = (patch: Partial<ManagerSheetBinding> = {}): ManagerSheetBinding =>
    normalizeManagerSheetBinding({
      id: "sheet_a",
      title: "Sales",
      spreadsheetId: AMBIKA_SALES_SPREADSHEET_ID,
      workspaceId: "ws-seattle",
      propertyId: ALL_SHEET_PROPERTIES,
      ...patch,
    })!;

  it("reads several workspace-scoped cards from sheetLinks", () => {
    const bindings = normalizeManagerSheetBindings({
      sheetLinks: [
        sales({ id: "sheet_5257", propertyId: "mgr-listing-1x3tiu0489ha" }),
        sales({ id: "sheet_all", propertyId: ALL_SHEET_PROPERTIES }),
      ],
    });
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toMatchObject({
      id: "sheet_5257",
      propertyId: "mgr-listing-1x3tiu0489ha",
      occupancyGid: AMBIKA_OCCUPANCY_GID,
    });
    expect(bindings[1].propertyId).toBeNull();
  });

  it("migrates a legacy single sheetLink into one card", () => {
    const bindings = normalizeManagerSheetBindings({
      sheetLink: { spreadsheetId: AMBIKA_SALES_SPREADSHEET_ID, occupancyGid: AMBIKA_OCCUPANCY_GID },
    });
    expect(bindings).toEqual([
      expect.objectContaining({
        id: "sheet_legacy",
        spreadsheetId: AMBIKA_SALES_SPREADSHEET_ID,
        occupancyGid: AMBIKA_OCCUPANCY_GID,
        propertyId: null,
      }),
    ]);
  });

  it("applies All to every house in that workspace", () => {
    const houses = ["mgr-listing-1x3tiu0489ha", "mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq"];
    expect(sheetBindingAppliesToProperty(sales(), houses[0], houses)).toBe(true);
    expect(sheetBindingAppliesToProperty(sales({ propertyId: houses[0] }), houses[1], houses)).toBe(false);
    expect(sheetBindingAppliesToProperty(sales({ propertyId: houses[0] }), houses[0], houses)).toBe(true);
  });

  it("filters the house map to the card's properties", () => {
    const map = new Map([
      ["5257", { id: "mgr-listing-1x3tiu0489ha" }],
      ["5259", { id: "mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq" }],
    ]);
    expect([...filterSheetPropertyMap(map, new Set(["mgr-listing-1x3tiu0489ha"])).keys()]).toEqual(["5257"]);
    expect(filterSheetPropertyMap(map, null).size).toBe(2);
  });
});

describe("occupancy grid (Residents tab)", () => {
  it("parses guest cells the way the Sales sheet writes them", () => {
    expect(parseOccupancyGuest("Grace")).toEqual({ name: "Grace", channel: null });
    expect(parseOccupancyGuest("Airbnb Ved")).toEqual({ name: "Ved", channel: "Airbnb" });
    expect(parseOccupancyGuest("Vinod Booking")).toEqual({ name: "Vinod", channel: "Booking" });
    expect(parseOccupancyGuest("Airbnb")).toBeNull();
    expect(parseOccupancyGuest("vacant")).toBeNull();
  });

  it("collapses date runs and carries house labels down the left column", () => {
    const stays = parseOccupancyGrid(parseCsv(OCCUPANCY_CSV), "2026-09-22");
    expect(stays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ houseKey: "4709A", roomNumber: 1, name: "Grace", channel: null, start: "2026-09-22", end: "2026-09-30" }),
        expect.objectContaining({ houseKey: "4709A", roomNumber: 3, name: "Ved", channel: "Airbnb" }),
        expect.objectContaining({ houseKey: "4709A", roomNumber: 4, name: "Vinod", channel: "Booking" }),
        expect.objectContaining({ houseKey: "5257", roomNumber: 1, name: "Heesu", channel: null }),
        expect.objectContaining({ houseKey: "5257", roomNumber: 4, name: "Chinese", channel: "Airbnb", start: "2026-09-22", end: "2026-09-22" }),
        expect.objectContaining({ houseKey: "5257", roomNumber: 4, name: "Rae", channel: "Airbnb", start: "2026-09-23", end: "2026-09-25" }),
        expect.objectContaining({ houseKey: "5257", roomNumber: 5, name: "Daiyun", channel: "Airbnb", start: "2026-09-23" }),
      ]),
    );
  });
});

describe("house P&L tab (roster + codes)", () => {
  it("reads 5257 Brooklyn codes and long-term rent, skips Airbnb placeholders", () => {
    const parsed = parseHouseTab(parseCsv(HOUSE_CSV), "Seattle 5257 Brooklyn", "2026-09-22");
    expect(parsed.houseKey).toBe("5257");
    expect(parsed.access.gateCode).toBe("07575");
    expect(parsed.access.doorCode).toBe("75000");
    expect(parsed.access.backGateCode).toBe("7501");
    expect(parsed.access.lockboxCode).toBe("56303");
    const heesu = parsed.rooms.find((room) => room.name === "Heesu");
    expect(heesu).toMatchObject({ roomNumber: 1, rentDollars: 850, utilitiesDollars: 150, airbnbPlaceholder: false });
    const riko = parsed.rooms.find((room) => room.name === "Riko");
    expect(riko?.monthToMonth).toBe(true);
    expect(parsed.rooms.find((room) => room.roomNumber === 4)?.airbnbPlaceholder).toBe(true);
  });

  it("reads per-room door codes from the 8th Ave roster", () => {
    const parsed = parseHouseTab(parseCsv(EIGHTH_CSV), "Seattle 8th Ave", "2026-09-22");
    expect(parsed.houseKey).toBe("4709A");
    const grace = parsed.rooms.find((room) => room.name.startsWith("Grace"));
    expect(grace?.doorCode).toBe("8916566666");
    expect(grace?.rentDollars).toBe(725);
    expect(accessNotes(parsed.access, parsed.rooms)).toContain("Room 1 Grace Natalie Halverson · 8916566666");
  });
});

describe("dates, money, matching", () => {
  it("parses occupancy headers and exclusive checkout", () => {
    expect(parseSheetDate("9/22", "2026-09-22")).toBe("2026-09-22");
    expect(parseSheetDate("9/30/2026")).toBe("2026-09-30");
    expect(exclusiveCheckoutAfterLastNight("2026-09-30")).toBe("2026-10-01");
    expect(parseMoneyDollars("$850")).toBe(850);
  });

  it("maps Seattle labels onto listings and refuses locked seeds", () => {
    expect(inferHouseKey("Seattle 5259 Brooklyn")).toBe("5259");
    expect(parseRoomNumber("Room 8")).toBe(8);
    expect(namesOverlap("Fekadu Daniel", "Fekadu")).toBe(true);
    expect(
      listingMatchesHouseKey("5257", { address: "5257 Brooklyn Ave NE", title: "", buildingName: "" }),
    ).toBe(true);
    expect(assertWritableSheetPropertyId("mgr--9-rooms-b1wf3z")).toMatch(/locked/i);
    expect(isLockedLiveListingId("mgr-listing-1x3tiu0489ha")).toBe(false);
    expect(
      resolveSheetPropertyId(
        "5257",
        [{ id: "mgr-listing-1x3tiu0489ha", address: "5257 Brooklyn Ave NE" }],
        { managerEmail: "ogambik2@gmail.com" },
      ),
    ).toBe("mgr-listing-1x3tiu0489ha");
  });
});
