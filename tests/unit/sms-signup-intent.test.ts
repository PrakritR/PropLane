// Sign-up by text, intent and answers (pure): who asks for an account, as what, and what the answers parse to.
import { describe, expect, it } from "vitest";
import {
  firstNameOf,
  isCancelText,
  isResendCodeText,
  parseBusinessName,
  parseEmailAnswer,
  parseFullName,
  parseHomeCount,
  readCodeReply,
  readSignupIntent,
  readSignupRoleAnswer,
} from "@/lib/one-number/signup/intent";

describe("readSignupIntent: manager", () => {
  it.each([
    "Hey I want to sign up as a manager",
    "sign me up as a property manager",
    "I'd like to create an account, I'm a landlord",
    "how do I register as a property owner",
    "I'm a landlord",
    "I am a property manager",
    "I manage 12 units and want to join PropLane",
    "create a manager account please",
  ])("%s", (text) => {
    expect(readSignupIntent(text)).toMatchObject({ wantsSignup: true, role: "manager" });
  });

  it("the captain's sentence is explicit, not implicit", () => {
    expect(readSignupIntent("Hey I want to sign up as a manager")).toEqual({ wantsSignup: true, role: "manager", implicit: false });
  });
});

describe("readSignupIntent: vendor", () => {
  it.each([
    "I want to sign up as a vendor",
    "sign me up, I'm a plumber",
    "create an account to get jobs",
    "register me as a contractor",
    "SIGNUP I do cleaning in Ballard",
  ])("%s", (text) => {
    expect(readSignupIntent(text)).toMatchObject({ wantsSignup: true, role: "vendor" });
  });

  it("a bare SIGNUP has no role of its own (the conversation asks, or reuses a vendor lead)", () => {
    expect(readSignupIntent("SIGNUP")).toEqual({ wantsSignup: true, role: null, implicit: false });
  });

  it("jobs questions alone are NOT a sign-up (the vendor flow answers those)", () => {
    expect(readSignupIntent("hey is there any available jobs in the area to do").wantsSignup).toBe(false);
    expect(readSignupIntent("handyman here").wantsSignup).toBe(false);
  });
});

describe("readSignupIntent: resident", () => {
  it.each([
    "I live at 61 Elm Street, can you set me up",
    "my landlord uses PropLane, sign me up",
    "I'm a tenant, create an account",
    "I live at 61 Elm Street",
  ])("%s", (text) => {
    expect(readSignupIntent(text)).toMatchObject({ wantsSignup: true, role: "resident" });
  });

  it("a repair or a payment from someone who lives somewhere is not a sign-up", () => {
    expect(readSignupIntent("I live at 61 Elm Street and the sink is broken").wantsSignup).toBe(false);
    expect(readSignupIntent("I live at 61 Elm Street, rent is late").wantsSignup).toBe(false);
  });
});

describe("readSignupIntent: what is NOT a sign-up", () => {
  it.each([
    "Is Room 3 available?",
    "I'm looking for a room near the U District",
    "can I sign up for a tour on Saturday",
    "I want to register for the waitlist",
    "sign up for text alerts",
    "any houses available for rent",
    "I own a 4 bedroom house at 123 Main St",
    "I own a house",
    "how much is the rent",
    "thanks",
    "",
  ])("%s", (text) => {
    expect(readSignupIntent(text).wantsSignup).toBe(false);
  });

  it("a renter who says 'sign me up' while searching still counts only when the words name a role", () => {
    expect(readSignupIntent("looking for a place to rent, sign me up").wantsSignup).toBe(false);
  });
});

describe("readSignupRoleAnswer", () => {
  it.each([
    ["1", "manager"],
    ["2", "vendor"],
    ["3", "resident"],
    ["property manager", "manager"],
    ["I'm a landlord", "manager"],
    ["plumber", "vendor"],
    ["a tenant", "resident"],
  ])("%s -> %s", (text, role) => {
    expect(readSignupRoleAnswer(text)).toBe(role);
  });
  it("unclear answers are null", () => {
    expect(readSignupRoleAnswer("banana")).toBeNull();
  });
});

describe("answers", () => {
  it("names", () => {
    expect(parseFullName("Jane Doe")).toBe("Jane Doe");
    expect(parseFullName("my name is jane doe")).toBe("Jane Doe");
    expect(parseFullName("I'm Jane")).toBe("Jane");
    expect(parseFullName("O'Brien-Smith")).toBe("O'Brien-Smith");
    expect(parseFullName("Zoë García")).toBe("Zoë García");
    for (const bad of ["", "x", "yes", "skip", "123", "jane@x.com", "what is this?", "a b c d e f g h", "http://x.com"]) expect(parseFullName(bad)).toBeNull();
    expect(firstNameOf("Jane Doe")).toBe("Jane");
  });

  it("business names", () => {
    expect(parseBusinessName("Doe Rentals LLC")).toEqual({ kind: "value", value: "Doe Rentals LLC" });
    expect(parseBusinessName("it's Doe Rentals")).toEqual({ kind: "value", value: "Doe Rentals" });
    expect(parseBusinessName("skip")).toEqual({ kind: "skip" });
    expect(parseBusinessName("?")).toEqual({ kind: "invalid" });
  });

  it("home counts", () => {
    expect(parseHomeCount("12")).toEqual({ kind: "value", value: 12 });
    expect(parseHomeCount("about 5 houses")).toEqual({ kind: "value", value: 5 });
    expect(parseHomeCount("three")).toEqual({ kind: "value", value: 3 });
    expect(parseHomeCount("none yet")).toEqual({ kind: "value", value: 0 });
    expect(parseHomeCount("0")).toEqual({ kind: "value", value: 0 });
    expect(parseHomeCount("skip")).toEqual({ kind: "skip" });
    expect(parseHomeCount("lots")).toEqual({ kind: "invalid" });
  });

  it("emails are lowercased claims; skip and junk are told apart", () => {
    expect(parseEmailAnswer("Jane@DoeRentals.com")).toEqual({ kind: "value", value: "jane@doerentals.com" });
    expect(parseEmailAnswer("my email is jane@doe.co ok")).toEqual({ kind: "value", value: "jane@doe.co" });
    expect(parseEmailAnswer("SKIP")).toEqual({ kind: "skip" });
    expect(parseEmailAnswer("no")).toEqual({ kind: "skip" });
    expect(parseEmailAnswer("jane at doe")).toEqual({ kind: "invalid" });
    expect(parseEmailAnswer("x@phone.proplane.invalid")).toEqual({ kind: "invalid" });
  });

  it("code replies", () => {
    expect(readCodeReply("482913")).toBe("482913");
    expect(readCodeReply(" 482 913 ")).toBe("482913");
    expect(readCodeReply("it's 482913")).toBe("482913");
    expect(readCodeReply("48291")).toBeNull();
    expect(readCodeReply("4829133")).toBeNull();
    expect(readCodeReply("hello")).toBeNull();
  });

  it("commands", () => {
    expect(isCancelText("cancel")).toBe(true);
    expect(isCancelText("Never mind")).toBe(true);
    expect(isCancelText("Jane")).toBe(false);
    expect(isResendCodeText("CODE")).toBe(true);
    expect(isResendCodeText("new code")).toBe(true);
    expect(isResendCodeText("482913")).toBe(false);
  });
});
