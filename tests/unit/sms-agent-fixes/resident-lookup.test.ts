import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { matchResidents, parseResidentQuery, residentLookupQuestion, type ResidentLookupHouse } from "@/lib/tools/domains/resident-lookup";

const TODAY = "2026-11-24";
const houses: ResidentLookupHouse[] = [
  { id: "p5259", title: "5259 Brooklyn Ave NE", rooms: new Map([["rm1", "Room 1"], ["rm2", "Room 2"], ["rm12", "Room 12"]]) },
  { id: "p5257", title: "5257 Brooklyn Ave NE", rooms: new Map([["ra", "Room 1"], ["rb", "Room 2"], ["r6", "Room 6"]]) },
  { id: "p4709a", title: "4709A 8th Ave NE", rooms: new Map([["r1", "Room 1"], ["r2", "Room 2"], ["r5", "Room 5"]]) },
];
const row = (over: Record<string, unknown>): DemoApplicantRow => ({ bucket: "approved", ...over }) as unknown as DemoApplicantRow;
const rows: DemoApplicantRow[] = [
  // Production format: `<propertyId>::<roomId>`, never the room's name.
  row({ id: "a1", name: "Dev Receipt", email: "dev@x.test", property: "5259 Brooklyn Ave NE", assignedRoomChoice: "p5259::rm2" }),
  row({ id: "a2", name: "Robin Locked", email: "robin@x.test", property: "5257 Brooklyn Ave NE", assignedRoomChoice: "p5257::r6" }),
  row({ id: "a3", name: "Eden Lease", email: "eden@x.test", property: "4709A 8th Ave NE", assignedRoomChoice: "p4709a::r2" }),
  row({ id: "a4", name: "Mo Movedout", email: "mo@x.test", property: "4709A 8th Ave NE", assignedRoomChoice: "p4709a::r2::r1", withdrawnAt: "2026-11-20T00:00:00Z" }),
  row({ id: "a5", name: "Pat Twelve", email: "pat@x.test", property: "5259 Brooklyn Ave NE", assignedRoomChoice: "p5259::rm12" }),
  row({ id: "a6", name: "Sam Two", email: "sam@x.test", property: "5257 Brooklyn Ave NE", assignedRoomChoice: "p5257::rb" }),
  row({ id: "a7", name: "Eden Five", email: "eden5@x.test", property: "4709A 8th Ave NE", assignedRoomChoice: "p4709a::r5" }),
];
const find = (q: string, includeMovedOut = false) => matchResidents(rows, houses, q, { today: TODAY, includeMovedOut });

describe("resident resolver: house + room display name", () => {
  it('"5259 Room 2" finds the resident by the room NAME, not the raw room id', () => {
    const out = find("5259 Room 2");
    expect(out.map((m) => m.email)).toEqual(["dev@x.test"]);
    expect(out[0]).toMatchObject({ roomLabel: "Room 2", houseTitle: "5259 Brooklyn Ave NE" });
  });

  it('"room 2 at 5259" and "5259 room 2" and "5259 #2" name the same person', () => {
    for (const q of ["room 2 at 5259", "5259 room 2", "Room 2 in the 5259 house", "5259 rm 2", "5259 #2"]) {
      expect(find(q).map((m) => m.email), q).toEqual(["dev@x.test"]);
    }
  });

  it("matches the house by its street number, with or without the street name, and a letter suffix", () => {
    expect(find("4709a Room 5").map((m) => m.email)).toEqual(["eden5@x.test"]);
    expect(find("5257 Brooklyn Room 6").map((m) => m.email)).toEqual(["robin@x.test"]);
    expect(find("5257 Room 6").map((m) => m.email)).toEqual(["robin@x.test"]);
  });

  it("Room 2 is not Room 12", () => {
    expect(find("5259 Room 2").map((m) => m.email)).not.toContain("pat@x.test");
    expect(find("5259 Room 12").map((m) => m.email)).toEqual(["pat@x.test"]);
  });

  it("a room number alone is ambiguous across houses: the resolver asks one question and names the candidates", () => {
    const out = find("Room 2");
    expect(out.map((m) => m.email).sort()).toEqual(["dev@x.test", "eden@x.test", "sam@x.test"]);
    const question = residentLookupQuestion(out, "Room 2")!;
    expect(question).toContain("More than one resident");
    expect(question).toContain("5259 Brooklyn Ave NE Room 2");
    expect(question).toContain("Which one");
  });

  it("a bare street number that fits two houses is ambiguous, not guessed", () => {
    expect(find("525 Room 2")).toEqual([]);
    expect(find("5257 5259 Room 2").length).toBe(0);
  });

  it("no match asks which house and room", () => {
    const out = find("5259 Room 9");
    expect(out).toEqual([]);
    expect(residentLookupQuestion(out, "5259 Room 9")).toContain("Which house and room");
  });

  it("exactly one match needs no question", () => {
    expect(residentLookupQuestion(find("5259 Room 2"), "5259 Room 2")).toBeNull();
  });

  it("a moved-out resident is hidden unless asked for, and flagged when included", () => {
    expect(find("4709a Room 2").map((m) => m.email)).toEqual(["eden@x.test"]);
    const both = find("4709a Room 2", true);
    expect(both.map((m) => [m.email, m.movedOut])).toEqual([["eden@x.test", false], ["mo@x.test", true]]);
  });

  it("the slot suffix on a room choice never turns the room id into the room", () => {
    // `p4709a::r2::r1` is room r2, slot 1. A room named "r1" would be Room 1.
    expect(find("4709a Room 1", true).map((m) => m.email)).toEqual([]);
    expect(find("4709a Room 2", true).map((m) => m.email)).toContain("mo@x.test");
  });

  it("a name still works, alone or with a house", () => {
    expect(find("eden").map((m) => m.email).sort()).toEqual(["eden5@x.test", "eden@x.test"]);
    expect(find("eden 4709a Room 5").map((m) => m.email)).toEqual(["eden5@x.test"]);
    expect(find("sam@x.test").map((m) => m.email)).toEqual(["sam@x.test"]);
  });

  it("a legacy row that stores the room NAME still resolves", () => {
    const legacy = [row({ id: "l1", name: "Lee", email: "lee@x.test", property: "5259 Brooklyn Ave NE", assignedPropertyId: "p5259", assignedRoomChoice: "Room 1" })];
    expect(matchResidents(legacy, houses, "5259 Room 1", { today: TODAY }).map((m) => m.email)).toEqual(["lee@x.test"]);
  });

  it("a house the actor cannot read still answers to the label on the resident's own row", () => {
    const other = [row({ id: "o1", name: "Ola", email: "ola@x.test", property: "9100 Aurora Ave N", propertyId: "p9100", assignedRoomChoice: "Room A" })];
    expect(matchResidents(other, [], "9100 Room A", { today: TODAY }).map((m) => m.email)).toEqual(["ola@x.test"]);
  });

  it("parses the room out of the text and keeps the house words", () => {
    expect(parseResidentQuery("room 2 at 5259", houses)).toEqual({ houseWords: ["5259"], roomText: "2", nameWords: [] });
  });
});
