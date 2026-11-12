import { describe, expect, it } from "vitest";
import { findAmount, findDate, parseManagerIntent, parseRelayShape } from "@/lib/manager-sms-commands/intent";

const TODAY = new Date(2026, 10, 12); // Nov 12, 2026

describe("manager text intents", () => {
  it("reads rent edits in the phrasings a manager types", () => {
    expect(parseManagerIntent("change room 4 at 5259 to 1150", TODAY)).toMatchObject({ kind: "edit", field: "rent", rentUsd: 1150 });
    expect(parseManagerIntent("5259 r4 rent $1,150", TODAY)).toMatchObject({ kind: "edit", field: "rent", rentUsd: 1150 });
    expect(parseManagerIntent("price to 1200", TODAY)).toMatchObject({ kind: "edit", field: "rent", rentUsd: 1200 });
    expect(parseManagerIntent("set rent for 4709a room 9 to $950/mo", TODAY)).toMatchObject({ field: "rent", rentUsd: 950 });
  });

  it("keeps the street number out of the amount and in the target text", () => {
    const intent = parseManagerIntent("change room 4 at 5259 to 1150", TODAY);
    expect(intent).toMatchObject({ kind: "edit", field: "rent" });
    if (intent.kind === "edit") {
      expect(intent.targetText).toContain("5259");
      expect(intent.targetText).toContain("room 4");
      expect(intent.targetText).not.toContain("1150");
    }
  });

  it("reads availability dates", () => {
    expect(parseManagerIntent("5259 r4 available dec 1", TODAY)).toMatchObject({ kind: "edit", field: "available", availableOn: "2026-12-01" });
    expect(parseManagerIntent("room 2 at 5257 available 12/15", TODAY)).toMatchObject({ field: "available", availableOn: "2026-12-15" });
    expect(parseManagerIntent("5259 room 4 available now", TODAY)).toMatchObject({ field: "available", availableOn: "now" });
    // a date already past rolls to next year, never silently into the past
    expect(findDate("available jan 3", TODAY)?.availableOn).toBe("2027-01-03");
    expect(findDate("available feb 30", TODAY)).toBeNull();
  });

  it("reads a description edit and whether it adds or replaces", () => {
    const replace = parseManagerIntent("description for room 4 at 5259: sunny, south-facing, new desk", TODAY);
    expect(replace).toMatchObject({ kind: "edit", field: "description", mode: "replace", text: "sunny, south-facing, new desk" });
    const add = parseManagerIntent("add to 5259 description: new washer and dryer", TODAY);
    expect(add).toMatchObject({ kind: "edit", field: "description", mode: "append", text: "new washer and dryer" });
    expect(parseManagerIntent("description for 5259", TODAY)).toEqual({ kind: "none" });
  });

  it("leaves questions, confirmations and other requests alone", () => {
    expect(parseManagerIntent("what is the rent at 5259?", TODAY)).toEqual({ kind: "none" });
    expect(parseManagerIntent("how many rooms are available", TODAY)).toEqual({ kind: "none" });
    expect(parseManagerIntent("YES 4821", TODAY)).toEqual({ kind: "confirmation" });
    expect(parseManagerIntent("no", TODAY)).toEqual({ kind: "confirmation" });
    expect(parseManagerIntent("remind everyone about trash day", TODAY)).toEqual({ kind: "none" });
    expect(parseManagerIntent("", TODAY)).toEqual({ kind: "none" });
  });

  it("starts and cancels the listing flow", () => {
    expect(parseManagerIntent("new listing", TODAY)).toEqual({ kind: "start_listing" });
    expect(parseManagerIntent("Create a listing", TODAY)).toEqual({ kind: "start_listing" });
    expect(parseManagerIntent("add a new house", TODAY)).toEqual({ kind: "start_listing" });
    expect(parseManagerIntent("cancel", TODAY)).toEqual({ kind: "cancel" });
    expect(parseManagerIntent("never mind", TODAY)).toEqual({ kind: "cancel" });
  });

  it("finds the rent among street numbers", () => {
    expect(findAmount("5259 room 4 to 1150")?.rentUsd).toBe(1150);
    expect(findAmount("5259 room 4 $1150")?.rentUsd).toBe(1150);
    expect(findAmount("make 5259 room 4 1150")?.rentUsd).toBe(1150);
    expect(findAmount("room 4")).toBeNull();
  });

  it("reads a relay only when the first word carries a digit", () => {
    expect(parseRelayShape("K7 yes Dec 1 works")).toEqual({ handle: "K7", message: "yes Dec 1 works" });
    expect(parseRelayShape("k7: sounds good")).toEqual({ handle: "K7", message: "sounds good" });
    expect(parseRelayShape("YES 4821")).toBeNull();
    expect(parseRelayShape("Hello there")).toBeNull();
    expect(parseRelayShape("K7")).toBeNull();
  });
});
