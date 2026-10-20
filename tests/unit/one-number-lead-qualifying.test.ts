// The Unassigned-lead qualifier, pure: what a text means, the order of the questions, and the fair-housing guard.
import { describe, expect, it } from "vitest";
import {
  applyAnswer,
  extractBathroom,
  extractBudget,
  extractFurnished,
  extractHousehold,
  extractLeaseMonths,
  extractMoveIn,
  isQualified,
  mergeModelFields,
  missingSteps,
  nextQuestion,
  questionFor,
  sanitizeModelFields,
  toGsm7,
  touchesProtectedTopic,
  withoutProtectedClauses,
  type LeadProfile,
} from "@/lib/one-number/lead-qualifying";

// Sunday Oct 18 2026, 10am Pacific.
const NOW = new Date("2026-10-18T17:00:00Z");

describe("budget", () => {
  it("reads dollars, thousands, per-month and phrased limits", () => {
    expect(extractBudget("$1,200 a month")).toBe(1200);
    expect(extractBudget("under 950")).toBe(950);
    expect(extractBudget("about 1.2k")).toBe(1200);
    expect(extractBudget("1100/mo")).toBe(1100);
    expect(extractBudget("my budget is 1300")).toBe(1300);
  });
  it("takes a bare number only when a budget was just asked", () => {
    expect(extractBudget("1500")).toBeUndefined();
    expect(extractBudget("1500", { bare: true })).toBe(1500);
    expect(extractBudget("$50", { bare: true })).toBeUndefined();
    expect(extractBudget("2 beds 3 baths")).toBeUndefined();
  });
});

describe("move-in date and lease length", () => {
  it("reads named, numeric, relative and flexible dates in Pacific time", () => {
    expect(extractMoveIn("Nov 1", NOW).date).toBe("2026-11-01");
    expect(extractMoveIn("november 15th please", NOW).date).toBe("2026-11-15");
    expect(extractMoveIn("11/15", NOW).date).toBe("2026-11-15");
    expect(extractMoveIn("1st of December", NOW).date).toBe("2026-12-01");
    expect(extractMoveIn("2027-01-05", NOW).date).toBe("2027-01-05");
    expect(extractMoveIn("in 2 weeks", NOW).date).toBe("2026-11-01");
    expect(extractMoveIn("next month", NOW).date).toBe("2026-11-01");
    expect(extractMoveIn("January", NOW).date).toBe("2027-01-01");
    expect(extractMoveIn("asap", NOW)).toMatchObject({ date: "2026-10-18", asap: true });
  });
  it("does not mistake ordinary words for months", () => {
    expect(extractMoveIn("the market is rough, I decided to look", NOW).date).toBeUndefined();
    expect(extractMoveIn("may I ask a question", NOW).date).toBeUndefined();
    expect(extractMoveIn("in may", NOW).date).toBe("2027-05-01");
  });
  it("reads a lease length and never takes 'in 2 months' for one", () => {
    expect(extractLeaseMonths("6 months")).toBe(6);
    expect(extractLeaseMonths("for twelve months")).toBe(12);
    expect(extractLeaseMonths("a year")).toBe(12);
    expect(extractLeaseMonths("month to month")).toBe(0);
    const moveIn = extractMoveIn("in 2 months", NOW);
    expect(moveIn.date).toBe("2026-12-18");
    expect(extractLeaseMonths("in 2 months", moveIn.used)).toBeUndefined();
    expect(extractLeaseMonths("in 2 months for 6 months", moveIn.used)).toBe(6);
  });
});

describe("room type and household", () => {
  it("reads bath and furnishing", () => {
    expect(extractBathroom("private bath")).toBe("private");
    expect(extractBathroom("a shared bathroom is fine")).toBe("shared");
    expect(extractBathroom("either")).toBe("any");
    expect(extractFurnished("furnished please")).toBe("yes");
    expect(extractFurnished("unfurnished")).toBe("no");
    expect(extractFurnished("furnished or unfurnished")).toBe("any");
  });
  it("reads a headcount and never infers one from nothing", () => {
    expect(extractHousehold("just me")).toBe(1);
    expect(extractHousehold("two of us")).toBe(2);
    expect(extractHousehold("me and my partner")).toBe(2);
    expect(extractHousehold("3 people")).toBe(3);
    expect(extractHousehold("2")).toBeUndefined();
    expect(extractHousehold("2", { bare: true })).toBe(2);
  });
});

describe("the questions come one at a time, in the fixed order", () => {
  it("budget, then move-in and lease, then area, then room type, then household", () => {
    let profile: LeadProfile = {};
    const asked: string[] = [];
    const answers: Record<string, string> = {
      budget: "$1200",
      move_in: "Nov 1 for 6 months",
      area: "near UW",
      room: "private bath, furnished",
      household: "just me",
    };
    for (let i = 0; i < 8 && !isQualified(profile); i += 1) {
      const q = nextQuestion(profile)!;
      asked.push(q.step);
      profile = applyAnswer({ ...profile, asked: q.step }, answers[q.step]!, NOW).profile;
    }
    expect(asked).toEqual(["budget", "move_in", "area", "room", "household"]);
    expect(profile).toMatchObject({ budgetMax: 1200, moveInDate: "2026-11-01", leaseMonths: 6, area: "UW", bathroom: "private", furnished: "yes", household: 1 });
    expect(nextQuestion(profile)).toBeNull();
  });

  it("narrows a half-answered question to what is still unknown", () => {
    const dateOnly = applyAnswer({ asked: "move_in", budgetMax: 1000 }, "Nov 1", NOW).profile;
    expect(nextQuestion(dateOnly)).toEqual({ step: "move_in", text: "How many months would you like to stay?" });
    const bathOnly = applyAnswer({ asked: "room" }, "private bath", NOW).profile;
    expect(nextQuestion({ ...bathOnly, budgetMax: 1, moveInDate: "2026-11-01", leaseMonths: 6, area: "UW" })?.text).toBe("Do you want it furnished or unfurnished?");
  });

  it("keeps an answer volunteered early and does not ask for it again", () => {
    const first = applyAnswer({}, "Looking for a room under $1100, move in Nov 1 for 6 months near UW", NOW).profile;
    expect(first).toMatchObject({ budgetMax: 1100, moveInDate: "2026-11-01", leaseMonths: 6, area: "UW" });
    expect(missingSteps(first)).toEqual(["room", "household"]);
  });

  it("lets a prospect decline to narrow ('any') without looping on the question", () => {
    const profile = applyAnswer({ asked: "budget" }, "doesn't matter", NOW).profile;
    expect(missingSteps(profile)).not.toContain("budget");
    const area = applyAnswer({ asked: "area" }, "anywhere", NOW).profile;
    expect(missingSteps(area)).not.toContain("area");
    const room = applyAnswer({ asked: "room" }, "either", NOW).profile;
    expect(room).toMatchObject({ bathroom: "any", furnished: "any" });
  });

  it("every question is plain GSM-7 and fits one segment", () => {
    const partials: LeadProfile[] = [{}, { moveInDate: "2026-11-01" }, { leaseMonths: 6 }, { bathroom: "any" }, { furnished: "yes" }];
    for (const step of ["budget", "move_in", "area", "room", "household"] as const) {
      for (const partial of partials) {
        const text = questionFor(step, partial);
        expect(toGsm7(text)).toBe(text);
        expect(text.length).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe("area", () => {
  it("is a place in the prospect's own words, never an acknowledgement", () => {
    expect(applyAnswer({ asked: "area" }, "near the UW campus", NOW).profile.area).toBe("the UW campus");
    expect(applyAnswer({ asked: "area" }, "Capitol Hill", NOW).profile.area).toBe("Capitol Hill");
    for (const ack of ["ok", "Okay.", "yes", "thanks!", "sounds good"]) {
      expect(applyAnswer({ asked: "area" }, ack, NOW).profile.area).toBeUndefined();
      expect(applyAnswer({ asked: "refine" }, ack, NOW).profile.area).toBeUndefined();
    }
  });
});

describe("fair housing: only price, dates, location and room features reach the profile", () => {
  const protectedAsks = [
    "are there a lot of families or kids in the house?",
    "what religion are the other tenants?",
    "is there a church nearby",
    "what kind of people live there",
    "is it a safe neighborhood?",
    "what are the roommates like",
    "I have a section 8 voucher",
    "I'm a single mom",
    "do you take veterans",
    "is it LGBT friendly",
    "I use a wheelchair",
    "any seniors in the building?",
    "does anyone there speak my language, I am an immigrant",
  ];
  it.each(protectedAsks)("flags: %s", (text) => {
    expect(touchesProtectedTopic(text)).toBe(true);
  });

  const ordinary = [
    "furnished room near UW under 1000",
    "a single room with a desk",
    "how much is the 2 bed",
    "do you allow a cat",
    "is there parking and laundry",
    "private bath please",
  ];
  it.each(ordinary)("does not flag: %s", (text) => {
    expect(touchesProtectedTopic(text)).toBe(false);
  });

  it("answers neutrally and changes nothing: no filter, no stored field", () => {
    const before: LeadProfile = { asked: "budget" };
    const result = applyAnswer(before, "what religion are the other tenants?", NOW);
    expect(result.neutral).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.profile).toEqual({ ...before, skipped: [] });
  });

  it("keeps the price and drops the rest of a mixed text", () => {
    const result = applyAnswer({ asked: "budget" }, "my budget is 1200 and I need a place without kids around", NOW);
    expect(result.neutral).toBe(true);
    expect(result.profile.budgetMax).toBe(1200);
    expect(JSON.stringify(result.profile)).not.toMatch(/kids|family|religion/i);
    expect(withoutProtectedClauses("my budget is 1200 and I need a place without kids around")).toBe("my budget is 1200");
  });

  it("household is a headcount: it is stored, but 'me and my kids' yields no family field", () => {
    const result = applyAnswer({ asked: "household" }, "2 people, one is a child", NOW);
    expect(result.profile.household).toBe(2);
    expect(Object.keys(result.profile).sort()).not.toContain("children");
  });
});

describe("model output is only ever a fallback, and is sanitized", () => {
  it("drops out-of-range, malformed and protected values", () => {
    const clean = sanitizeModelFields(
      { budgetMax: 99999, moveInDate: "2030-01-01", leaseMonths: 99, area: "near the church for Muslims", bathroom: "huge", furnished: "yes", household: 40, evil: "x" },
      NOW,
    );
    expect(clean).toEqual({ furnished: "yes" });
    expect(sanitizeModelFields("nope", NOW)).toEqual({});
  });
  it("accepts well-formed values", () => {
    expect(sanitizeModelFields({ budgetMax: "1250", moveInDate: "2026-12-01", leaseMonths: 0, area: " Fremont ", bathroom: "private", household: 2 }, NOW)).toEqual({
      budgetMax: 1250,
      moveInDate: "2026-12-01",
      leaseMonths: 0,
      area: "Fremont",
      bathroom: "private",
      household: 2,
    });
  });
  it("merges the asked step's fields, and others only when unknown", () => {
    const merged = mergeModelFields({ budgetMax: 900, area: "UW" }, { budgetMax: 1500, area: "Ballard", household: 2 }, "budget");
    expect(merged).toMatchObject({ budgetMax: 1500, area: "UW", household: 2 });
  });
});

describe("text hygiene", () => {
  it("strips curly quotes, long dashes and emoji so a text stays one GSM-7 segment", () => {
    expect(toGsm7("It’s “great” — call … 😀")).toBe(`It's "great" - call ...`);
  });

  it("keeps a person's name readable: an accented letter is folded, never deleted", () => {
    // One implementation (`one-number/segments.ts`). A second copy here dropped every non-ASCII character, so the
    // sign-up welcome texted "You're set, Jos." to Jose and "Zo" to Zoe.
    expect(toGsm7("You're set, José.")).toBe("You're set, José.");
    expect(toGsm7("Zoë")).toBe("Zoe");
    expect(toGsm7("Björk")).toBe("Björk");
  });
});
