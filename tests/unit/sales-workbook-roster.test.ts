/**
 * Reading the Sales workbook's room roster.
 *
 * These rows become real residents with real rent charges, so the tests are weighted toward what
 * the parser must REFUSE. A missing rent figure costs a manager one correction; a wrong one bills
 * a person for money they do not owe.
 *
 * Three properties of the source drive almost every case: the roster shares its rows with an
 * unrelated P&L on the left and a past-tenant deposits ledger on the right; column positions
 * differ between tabs; and the sheet contains hand-typed values that are simply wrong.
 */
import { describe, expect, it } from "vitest";
import {
  excelSerialToIso,
  isShortTermName,
  readDateCell,
  readMoneyCell,
  readPhoneCell,
  readMoveInCode,
  readRoomNumber,
  readSalesWorkbookRoster,
} from "@/lib/sales-workbook-roster";

describe("dates", () => {
  it("converts an Excel serial off the 1899-12-30 epoch", () => {
    expect(excelSerialToIso(46387)).toBe("2026-12-31");
    expect(readDateCell("46326").iso).toBe("2026-10-31");
  });

  it("reads a date the same way wherever the import runs", () => {
    // Built in UTC on purpose: a local construction shifts a lease end across a day boundary
    // depending on the machine's timezone.
    expect(readDateCell("46255").iso).toBe("2026-08-21");
  });

  it("treats month-to-month as an answer, not a missing date", () => {
    for (const raw of ["Month to Month", "month to month", "Month-to-Month"]) {
      const read = readDateCell(raw);
      expect(read.monthToMonth).toBe(true);
      expect(read.iso).toBe("");
      expect(read.problem).toBe("");
    }
  });

  it("refuses a mistyped date rather than repairing it", () => {
    // The sheet really contains "8/3122026". Guessing 2026 invents a lease term nobody agreed to.
    const read = readDateCell("8/3122026");
    expect(read.iso).toBe("");
    expect(read.problem).toBeTruthy();
  });

  it("accepts a plainly written calendar date", () => {
    expect(readDateCell("8/31/2026").iso).toBe("2026-08-31");
  });

  it("says nothing for an empty cell", () => {
    expect(readDateCell("  ")).toEqual({ iso: "", monthToMonth: false, problem: "" });
  });
});

describe("money", () => {
  it("reads a plain figure", () => {
    expect(readMoneyCell("725.0").amount).toBe(725);
    expect(readMoneyCell("$1,100").amount).toBe(1100);
  });

  it("refuses a figure with a note attached", () => {
    // "350 for rent" means part of a deposit was applied to rent. Banking the 350 alone would keep
    // the number and discard what it meant.
    const read = readMoneyCell("350 for rent");
    expect(read.amount).toBeNull();
    expect(read.problem).toBeTruthy();
  });

  it("returns nothing, and no complaint, for a blank", () => {
    expect(readMoneyCell("")).toEqual({ amount: null, problem: "" });
  });
});

describe("phones", () => {
  it("normalizes the formats the sheet actually uses", () => {
    expect(readPhoneCell("(715) 419-2818")).toBe("+17154192818");
    expect(readPhoneCell("(425)583-6477")).toBe("+14255836477");
    expect(readPhoneCell("(613) 404 3480")).toBe("+16134043480");
  });

  it("strips the invisible marks a paste leaves behind", () => {
    expect(readPhoneCell("‪(613) 404‑3480‬")).toBe("+16134043480");
  });

  it("refuses anything that is not a whole US number", () => {
    // A partial number on a resident record is a message sent to a stranger.
    for (const raw of ["2.066700043E9", "555-1234", "", "n/a"]) {
      expect(readPhoneCell(raw)).toBe("");
    }
  });
});

describe("who is actually a resident", () => {
  it("reads every Airbnb spelling as a short-term let", () => {
    // A resident record provisions an account and bills someone — a listing must never become one.
    for (const raw of ["Airbnb", "Airbnb ", "Airbnb Ryan", "Airbnb Khue Doan"]) {
      expect(isShortTermName(raw)).toBe(true);
    }
  });

  it("does not mistake a person for a listing", () => {
    expect(isShortTermName("Grace Natalie Halverson")).toBe(false);
  });
});

describe("move-in codes", () => {
  it("expands the scientific notation Excel stores a long numeric code as", () => {
    // These are keypad codes, not quantities — "7.820341022E9" is nine digits someone presses.
    expect(readMoveInCode("7.820341022E9")).toBe("7820341022");
    expect(readMoveInCode("3.28236213E9")).toBe("3282362130");
  });

  it("keeps a leading zero, which numeric parsing would eat", () => {
    // "0497" is not 497 — the keypad cares.
    expect(readMoveInCode("0497")).toBe("0497");
    expect(readMoveInCode("0831979973")).toBe("0831979973");
  });

  it("passes an ordinary code through unchanged", () => {
    expect(readMoveInCode("7528")).toBe("7528");
    expect(readMoveInCode("")).toBe("");
  });
});

describe("room labels", () => {
  it("accepts the spacings the sheet mixes", () => {
    expect(readRoomNumber("Room 1")).toBe(1);
    expect(readRoomNumber("Room2")).toBe(2);
    expect(readRoomNumber("Room 10")).toBe(10);
  });

  it("rejects anything that is not a room row", () => {
    for (const raw of ["Pantry", "Mailbox", "Front door", "", "Room"]) {
      expect(readRoomNumber(raw)).toBeNull();
    }
  });
});

describe("reading a tab", () => {
  // Mirrors the real layout: P&L on the left, roster in the middle, deposits ledger on the right,
  // all sharing rows. Room label sits in an UNLABELED column left of Name.
  const sheet: string[][] = [
    ["Purchase", "Down Payment"],
    ["1053048.44", "203150.0"],
    ["", "", "Door Code", "", "Name", "Phone", "Rent", "Utilities", "Deposit", "Lease Ends", "", "Old Tenant", "Deposit"],
    ["45839", "2089.81", "8916566666", "Room 1", "Grace Natalie Halverson", "(715) 419-2818", "725.0", "150.0", "500.0", "46387", "", "Tamra L. Calvert", "600.0"],
    ["45870", "3333.1", "", "Room2", "Airbnb", "", "", "", "", "", "", "Andrea Grace Jones", "500.0"],
    ["45901", "3987.0", "", "Room3", "Nehemie Pluviose", "(786) 499-2817", "750.0", "125.0", "750.0", "Month to Month", "", "Isaac R. Muhlestein", "600.0"],
    ["45931", "6841.92", "", "Room4", "", "", "800.0", "", "", "", "", "David J. Hernandez", "600.0"],
    ["", "", "", "Pantry", "", "", "", "", "", "", "", "Norton", "100.0"],
  ];
  const { rooms, issues } = readSalesWorkbookRoster(sheet);

  it("takes only the roster block, not the two blocks sharing its rows", () => {
    // The P&L's 2089.81 and the ledger's 600.0 sit on the same rows as Room 1.
    expect(rooms.map((r) => r.room)).toEqual(["Room 1", "Room2", "Room3", "Room4"]);
  });

  it("does not let the deposits ledger's Deposit column shadow the roster's", () => {
    // `Deposit` appears twice on the header row; the roster's is the leftmost.
    expect(rooms[0]!.depositHeld).toBe(500);
    expect(rooms[2]!.depositHeld).toBe(750);
  });

  it("reads a resident's terms", () => {
    const room1 = rooms[0]!;
    expect(room1.occupancy).toBe("resident");
    expect(room1.residentName).toBe("Grace Natalie Halverson");
    expect(room1.residentPhone).toBe("+17154192818");
    expect(room1.monthlyRent).toBe(725);
    expect(room1.monthlyUtilities).toBe(150);
    expect(room1.leaseEndIso).toBe("2026-12-31");
    expect(room1.moveInCode).toBe("8916566666");
  });

  it("keeps a short-term room out of the resident set without dropping the room", () => {
    const room2 = rooms[1]!;
    expect(room2.occupancy).toBe("short-term");
    expect(room2.residentName).toBe("");
  });

  it("marks a named-rent room with nobody in it as vacant", () => {
    const room4 = rooms[3]!;
    expect(room4.occupancy).toBe("vacant");
    expect(room4.monthlyRent).toBe(800);
  });

  it("carries month-to-month through rather than inventing an end date", () => {
    expect(rooms[2]!.monthToMonth).toBe(true);
    expect(rooms[2]!.leaseEndIso).toBe("");
  });

  it("reads the move-in code from the column left of the room, not from a header", () => {
    // On two tabs that column has no header at all, and on one it sits under a stray "Parcel #"
    // label belonging to the block above. The code is what gets a resident through the door, so
    // reading the wrong column is worse than reading nothing.
    const tab: string[][] = [
      ["", "Parcel #", "", "Name", "Rent"],
      ["", "7528", "Room 1", "Fekadu", "1100"],
      ["", "5223", "Room2", "Tarif", "1100"],
    ];
    const { rooms } = readSalesWorkbookRoster(tab);
    expect(rooms.map((r) => r.moveInCode)).toEqual(["7528", "5223"]);
  });

  it("does not borrow the ledger's Deposit when the roster has none of its own", () => {
    // The real 5259 tab. Its roster stops at `Lease Ends`; the flat 600 to the right belongs to a
    // ledger of PAST tenants. Matching by header name alone reached across the gutter and put that
    // 600 on all nine rooms — a deposit nobody agreed to, on people who are not those people.
    const tab: string[][] = [
      ["", "", "", "Name", "Phone", "Rent", "Utilities", "Lease starts", "Lease Ends", "", "Old Tenant", "Phone Number", "Deposit"],
      ["", "", "Room 1", "Airbnb", "", "", "", "", "", "", "Connor", "(774) 270-2926", "600.0"],
      ["", "", "Room2", "Fekadu Daniel", "(425)583-6477", "1100.0", "", "46255", "46326", "", "Jeewok", "(404) 610-9875", "600.0"],
    ];
    const { rooms } = readSalesWorkbookRoster(tab);
    expect(rooms.every((r) => r.depositHeld === null)).toBe(true);
    // The roster's own columns still read correctly on the same row.
    expect(rooms[1]!.monthlyRent).toBe(1100);
    expect(rooms[1]!.residentPhone).toBe("+14255836477");
  });

  it("returns nothing for a tab with no roster instead of guessing at one", () => {
    expect(readSalesWorkbookRoster([["Purchase"], ["1053048.44"]])).toEqual({ rooms: [], issues: [] });
  });

  it("reports a problem cell rather than silently dropping it", () => {
    const withNote = readSalesWorkbookRoster([
      ["", "", "", "Name", "Rent"],
      ["", "", "Room 1", "Ada", "350 for rent"],
    ]);
    expect(withNote.issues).toContainEqual(
      expect.objectContaining({ room: "Room 1", field: "rent", raw: "350 for rent" }),
    );
    expect(withNote.rooms[0]!.monthlyRent).toBeNull();
  });
});
