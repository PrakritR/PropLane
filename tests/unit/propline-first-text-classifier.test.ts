// The first text from an unknown number: a deterministic classifier (no model) says whether it is CLEAR (one role) or UNCLEAR
// (a greeting, "who is this", no signal, or two roles at once), and reads the answer to the one question we ask.
import { describe, expect, it } from "vitest";
import {
  MANAGE_OWN_REPLY,
  PROPLANE_ROLE_QUESTION,
  RESIDENT_NOT_FOUND_REPLY,
  VENDOR_TRADE_QUESTION,
  classifyFirstText,
  firstTextRoles,
  readRoleQuestionAnswer,
  roleQuestionFor,
} from "@/lib/sms/propline-first-text";

describe("an unclear first text asks the question", () => {
  it.each(["hi", "Hi", "hello?", "Hello", "who is this", "Who is this?", "who's this", "hey", "yo", "what is this", "?", "ok", "can you call me", "hey there!", "hola", "is anyone there"])(
    "%s is unclear",
    (text) => expect(classifyFirstText(text)).toEqual({ kind: "unclear" }),
  );

  it("an empty text is unclear (nothing to read)", () => {
    expect(classifyFirstText("")).toEqual({ kind: "unclear" });
    expect(classifyFirstText("   ")).toEqual({ kind: "unclear" });
  });

  it("two roles at once is unclear: it asks rather than guessing", () => {
    // A renter looking for a place who also does cleaning.
    const text = "I'm a plumber looking for a room near UW";
    expect(firstTextRoles(text).sort()).toEqual(["looking", "vendor"]);
    expect(classifyFirstText(text)).toEqual({ kind: "unclear" });
  });
});

describe("a clear first text skips the question", () => {
  it.each([
    ["Any rooms near UW under $1,000?", "looking"],
    ["Is Room 3 still available?", "looking"],
    ["looking for a room in Capitol Hill", "looking"],
    ["hey is there any house available", "looking"],
    ["Is 5259 Brooklyn still open?", "looking"],
    ["Hi, I'd like to book 4709A 8th Ave", "looking"],
    ["can I schedule a tour", "looking"],
    ["I'm a plumber", "vendor"],
    ["I do cleaning in Seattle", "vendor"],
    ["any jobs available in the area", "vendor"],
    ["I'm a handyman looking for work", "vendor"],
    ["I own 3 houses in Tacoma", "manage"],
    ["I want to manage my own property with PropLane", "manage"],
    ["I'm a landlord", "manage"],
    ["sign me up", "manage"],
    ["I'm a tenant at 12 Elm St", "resident"],
    ["my sink is leaking", "resident"],
    ["I live at 5259 Brooklyn", "resident"],
    ["when is rent due", "resident"],
  ])("%s is clear: %s", (text, role) => {
    expect(classifyFirstText(text)).toEqual({ kind: "clear", role });
  });
});

describe("the answer to the question", () => {
  it.each([
    ["resident", "resident"],
    ["I'm a resident", "resident"],
    ["a tenant", "resident"],
    ["vendor", "vendor"],
    ["a vendor", "vendor"],
    ["I do plumbing", "vendor"],
    ["looking for a place", "looking"],
    ["a place to rent", "looking"],
    ["looking", "looking"],
    ["manage my own property", "manage"],
    ["I want to manage my own", "manage"],
    ["landlord", "manage"],
    ["renting one out", "manage"],
  ])("%s -> %s", (text, role) => {
    expect(readRoleQuestionAnswer(text)).toBe(role);
  });

  it("an answer that names no role, or two, is not read as one", () => {
    expect(readRoleQuestionAnswer("hmm not sure")).toBeNull();
    expect(readRoleQuestionAnswer("")).toBeNull();
    expect(readRoleQuestionAnswer("a resident or a vendor")).toBeNull();
  });
});

describe("the copy", () => {
  it("the PropLane line's question is exact, one GSM-7 segment, no long dash", () => {
    expect(PROPLANE_ROLE_QUESTION).toBe("Hi, this is PropLane. Are you a resident, a vendor, looking for a place, or want to manage your own property with PropLane?");
    for (const text of [PROPLANE_ROLE_QUESTION, MANAGE_OWN_REPLY, RESIDENT_NOT_FOUND_REPLY, VENDOR_TRADE_QUESTION]) {
      expect(text).toMatch(/^[\x20-\x7E]+$/);
      expect(text.length).toBeLessThanOrEqual(160);
      expect(text).not.toMatch(/[–—]/);
    }
  });

  it("the manage-my-own answer carries the create-account link, last-word clean, and the Pro line", () => {
    expect(MANAGE_OWN_REPLY).toBe("Great, set up your homes here: https://proplane.ai/auth/create-account?role=manager A personal work number comes with Pro.");
  });

  it("a manager's own number says its workspace's name where PropLane's would be; the last clause is kept", () => {
    expect(roleQuestionFor("Seattle Homes")).toBe("Hi, this is Seattle Homes. Are you a resident, a vendor, looking for a place, or want to manage your own property with PropLane?");
    expect(roleQuestionFor("PropLane")).toBe(PROPLANE_ROLE_QUESTION);
    expect(roleQuestionFor("")).toBe(PROPLANE_ROLE_QUESTION);
    expect(roleQuestionFor(null)).toBe(PROPLANE_ROLE_QUESTION);
  });

  it("a long or non-ASCII workspace name is cut and cleaned so the text stays one segment", () => {
    const text = roleQuestionFor("Éléonore’s Extraordinarily Long Property Management Company of Louisville");
    expect(text).toMatch(/^[\x20-\x7E]+$/);
    expect(text.length).toBeLessThanOrEqual(160);
  });
});
