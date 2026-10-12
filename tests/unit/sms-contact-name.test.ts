import { describe, expect, it } from "vitest";
import {
  contactNameRepairVerdict,
  isPlausibleContactName,
  parseNameFromInboundText,
} from "@/lib/sms/contact-name";

describe("parseNameFromInboundText: only an explicit self-introduction that looks like a name", () => {
  it.each([
    ["my name is Maya Chen", "Maya Chen"],
    ["Hi, my name is Maya Chen and I want a room", "Maya Chen"],
    ["Hi this is Morgan Lee — tour?", "Morgan Lee"],
    ["Hello, I'm Sarah. Is the room still available?", "Sarah"],
    ["I am Priya Raman, a UW student", "Priya Raman"],
    ["Hey I’m Jean-Luc Picard", "Jean-Luc Picard"],
    ["my name is maya", "Maya"],
    ["My name is Will", "Will"],
    ["Hi I'm Maya and I'm looking for a room", "Maya"],
  ])("accepts %j -> %j", (body, expected) => {
    expect(parseNameFromInboundText(body)).toBe(expected);
  });

  it.each([
    "Hi I'm looking for a room",
    "hi im looking for a place near campus",
    "I'm interested in 5257",
    "I'm interested in the room on Brooklyn",
    "Im wondering if the room is still available",
    "I am here for the tour",
    "I'm a student at UW",
    "I'm Looking For A Room",
    "this is maya",
    "this is about the room at 5257 Brooklyn Ave",
    "This is Brooklyn Ave",
    "I'm LOOKING",
    "I'm in Seattle until June",
    "It's available right?",
    "How much is the room",
    "hi",
    "",
  ])("never stores a phrase: %j", (body) => {
    expect(parseNameFromInboundText(body)).toBe("");
  });
});

describe("isPlausibleContactName", () => {
  it("accepts person names", () => {
    for (const name of ["Maya", "Maya Chen", "maya chen".replace("m", "M").replace("c", "C"), "Jean-Luc Picard", "O'Brien", "Will Smith"]) {
      expect(isPlausibleContactName(name)).toBe(true);
    }
  });

  it("rejects phrases, phone labels and junk", () => {
    for (const name of ["looking for", "Looking for", "interested in the room", "here", "a student", "(425) 984-9697", "+14259849697", "hi", "", "5257 Brooklyn", "maya chen jr the third of kings", "x"]) {
      expect(isPlausibleContactName(name)).toBe(false);
    }
  });
});

describe("contactNameRepairVerdict", () => {
  it("clears guessed phrases and phone labels, keeps names and blanks", () => {
    expect(contactNameRepairVerdict("looking for")).toMatchObject({ keep: false });
    expect(contactNameRepairVerdict("interested in the room")).toMatchObject({ keep: false });
    expect(contactNameRepairVerdict("a student")).toMatchObject({ keep: false });
    expect(contactNameRepairVerdict("(425) 984-9697")).toMatchObject({ keep: false });
    expect(contactNameRepairVerdict("+14259849697")).toMatchObject({ keep: false });
    expect(contactNameRepairVerdict("Plumber · (425) 984-9697")).toMatchObject({ keep: false });
    expect(contactNameRepairVerdict("Maya Chen")).toEqual({ keep: true });
    expect(contactNameRepairVerdict("maya")).toEqual({ keep: true });
    expect(contactNameRepairVerdict(null)).toEqual({ keep: true });
  });

  // The repair deletes data, so it is narrower than the rule that gates a NEW guess: every one of
  // these fails `isPlausibleContactName` and is still something a manager may have typed.
  it("never clears a name or label a manager could have typed", () => {
    for (const name of ["Maya West", "Guy Fieri", "Joe's Plumbing 24/7", "Unit 4", "Rico North", "Dana Place", "5257 Brooklyn"]) {
      expect(isPlausibleContactName(name)).toBe(false);
      expect(contactNameRepairVerdict(name)).toEqual({ keep: true });
    }
  });
});
