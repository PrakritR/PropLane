// "HEY I WANT TO LIST MY PROPERTY": a landlord's listing ask is a manager sign-up, a renter's search or tour ask never is.
import { describe, expect, it } from "vitest";
import { readSignupIntent } from "@/lib/one-number/signup/intent";

describe("a listing ask is a manager sign-up", () => {
  it.each([
    "HEY I WANT TO LIST MY PROPERTY",
    "I want to list my property",
    "i'd like to list my house on proplane",
    "list my rooms please",
    "Can you post my rental?",
    "I want to rent out my place",
    "We want to rent out our basement",
    "I have a room for rent in Ballard",
    "I own 3 houses to list",
    "I want to rent it out",
    "I'm a landlord",
    "IM A LANDLORD",
    "advertise my apartment",
    "I want to put my unit on here",
  ])("%s", (text) => {
    expect(readSignupIntent(text)).toMatchObject({ wantsSignup: true, role: "manager", implicit: true });
  });
});

describe("a renter or a tour ask is never read as a landlord sign-up", () => {
  it.each([
    "I'm looking for a room near UW",
    "any rooms for rent?",
    "list rooms near UW under $1000",
    "Can you list the rooms that are available?",
    "I want to tour a room",
    "I want to apply for the room on 8th Ave",
    "can I see the place on Saturday",
    "I need a room, rent out of my budget is $900",
    "I'm a landlord looking for a place to rent",
    "I want to list my property but first can I tour the room",
    "sign up for a tour",
    "hi",
  ])("%s", (text) => {
    expect(readSignupIntent(text).wantsSignup).toBe(false);
  });
});
