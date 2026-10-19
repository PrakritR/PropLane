// Who is an unknown number? The inference matrix, the one-time ask, house hints and the vendor intake reader.
import { describe, expect, it } from "vitest";
import {
  extractAddress,
  extractHouseHints,
  extractRent,
  extractRoomCount,
  inferSenderRole,
  isAccept,
  isDecline,
  mergeHints,
  parseCount,
  readRoleAnswer,
} from "@/lib/one-number/onboarding/role-detect";
import { applyVendorText, extractArea, extractInsurance, extractRates, extractTrade, nextVendorStep } from "@/lib/one-number/onboarding/vendor-intake";

describe("inferSenderRole", () => {
  it.each([
    ["Is Room 3 available?", "searcher"],
    ["is the room still available", "searcher"],
    ["Looking for a room near UW", "searcher"],
    ["I'm searching for an apartment in Ballard", "searcher"],
    ["Can I schedule a tour?", "searcher"],
    ["saw your listing on Zumper", "searcher"],
    ["how much is rent", "searcher"],
    ["any rooms open for November?", "searcher"],
    ["I want to rent a room", "searcher"],
    ["Hey, are there any houses available in the Seattle area for rent?", "searcher"],
    ["do you have any apartments for rent near UW", "searcher"],
    ["any places available in Ballard?", "searcher"],
    ["houses for rent in Seattle", "searcher"],
    ["I own a house in Seattle", "landlord"],
    ["I'm a landlord with 4 rentals", "landlord"],
    ["I manage 12 units on Capitol Hill", "landlord"],
    ["looking to rent out my house", "landlord"],
    ["need help with my rentals", "landlord"],
    ["my tenants pay late", "landlord"],
    ["I'm a property manager", "landlord"],
    ["I have a house for rent", "landlord"],
    ["I do cleaning in Seattle", "vendor"],
    ["I'm a plumber, 98115", "vendor"],
    ["vendor signup", "vendor"],
    ["we are a handyman company", "vendor"],
    ["I need more work, I do landscaping", "vendor"],
    ["I clean houses in Bellevue", "vendor"],
  ])("%s -> %s", (text, role) => {
    expect(inferSenderRole(text)).toBe(role);
  });

  it.each(["hi", "hello there", "what is this", "ok", "", "   ", "yes", "who is this?"])("%j says nothing", (text) => {
    expect(inferSenderRole(text)).toBeNull();
  });

  it("a landlord looking for a plumber is a landlord, not a vendor", () => {
    expect(inferSenderRole("I own two houses and I'm looking for a plumber")).toBe("landlord");
  });

  it("a tenant asking for a plumber is not a vendor", () => {
    expect(inferSenderRole("looking for a plumber")).not.toBe("vendor");
  });
});

describe("readRoleAnswer (the one question)", () => {
  it.each([
    ["a place", "searcher"],
    ["looking for a place", "searcher"],
    ["1", "searcher"],
    ["renting one out", "landlord"],
    ["2", "landlord"],
    ["landlord", "landlord"],
    ["vendor", "vendor"],
    ["3", "vendor"],
    ["I'm a vendor", "vendor"],
    ["I do plumbing", "vendor"],
  ])("%s -> %s", (text, role) => {
    expect(readRoleAnswer(text)).toBe(role);
  });

  it.each(["maybe", "hmm", "what?", "ok", ""])("%j still does not say", (text) => {
    expect(readRoleAnswer(text)).toBeNull();
  });
});

describe("house hints", () => {
  it("reads an address", () => {
    expect(extractAddress("my place is at 61 Willow Court in Seattle")).toBe("61 Willow Court");
    expect(extractAddress("123 N Main St")).toBe("123 N Main St");
    expect(extractAddress("4709A 8th Ave")).toBe("4709A 8th Ave");
    expect(extractAddress("I own a house")).toBeNull();
  });
  it("reads rooms and rent", () => {
    expect(extractRoomCount("a 4 bedroom house")).toBe(4);
    expect(extractRoomCount("three rooms")).toBe(3);
    expect(extractRoomCount("hello")).toBeNull();
    expect(extractRent("rent is $850")).toBe(850);
    expect(extractRent("900/mo")).toBe(900);
    expect(extractRent("$50")).toBeNull();
  });
  it("collects hints from one text and never lets a later text erase one", () => {
    const hints = extractHouseHints("I own a 4 bedroom house at 123 Main St, $800 a room");
    expect(hints).toEqual({ address: "123 Main St", rooms: 4, rent: 800 });
    expect(mergeHints(hints, { address: "9 Other St", rooms: 2 })).toEqual(hints);
    expect(mergeHints({}, { rooms: 2 })).toEqual({ rooms: 2 });
  });
  it("parses counts", () => {
    expect(parseCount("3")).toBe(3);
    expect(parseCount("seven")).toBe(7);
    expect(parseCount("0")).toBeNull();
    expect(parseCount("lots")).toBeNull();
  });
});

describe("accept and decline", () => {
  it("reads yes and no", () => {
    for (const t of ["DEMO", "yes", "sure", "ok", "Yeah!"]) expect(isAccept(t)).toBe(true);
    for (const t of ["no", "not now", "skip", "nope"]) expect(isDecline(t)).toBe(true);
    expect(isAccept("what is this")).toBe(false);
  });
});

describe("vendor intake reader", () => {
  it("reads a trade, an area, rates and insurance", () => {
    expect(extractTrade("I do cleaning")).toBe("cleaning");
    expect(extractTrade("licensed plumber")).toBe("plumbing");
    expect(extractArea("I do cleaning in Seattle")).toBe("Seattle");
    expect(extractArea("covering 98115 and 98105")).toBe("98115, 98105");
    expect(extractRates("$45/hr")).toBe("$45/hr");
    expect(extractRates("about $120 per job")).toBe("$120 per job");
    expect(extractInsurance("yes")).toBe("yes");
    expect(extractInsurance("No")).toBe("no");
    expect(extractInsurance("fully insured")).toBe("yes");
    expect(extractInsurance("maybe")).toBeNull();
  });
  it("keeps what was volunteered and asks the rest in order", () => {
    const first = applyVendorText({}, "I do cleaning in Seattle");
    expect(first.profile).toMatchObject({ trade: "cleaning", area: "Seattle" });
    expect(nextVendorStep(first.profile)).toBe("rates");
    const second = applyVendorText({ ...first.profile, asked: "rates" }, "$40/hr");
    expect(nextVendorStep(second.profile)).toBe("insurance");
    const third = applyVendorText({ ...second.profile, asked: "insurance" }, "yes");
    expect(nextVendorStep(third.profile)).toBeNull();
  });
  it("takes a plain answer to the step just asked", () => {
    const r = applyVendorText({ asked: "trade" }, "gutters and siding");
    expect(r.profile.trade).toBe("gutters and siding");
  });
  it("does not accept a non answer to the insurance question", () => {
    const r = applyVendorText({ asked: "insurance", trade: "a", area: "b", rates: "c" }, "what do you mean");
    expect(r.profile.insurance).toBeUndefined();
    expect(r.changed).toBe(false);
  });
});
