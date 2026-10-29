import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeHouseInfo } from "@/lib/house-info";
import { isFastPathCandidate, matchResidentFastPath } from "@/lib/one-number/resident-fast-path";

const HOUSE = normalizeHouseInfo({
  access: { doorCode: "4821", gateCode: "77#", parking: "Street parking, no permit needed" },
  wifi: { network: "4709A", password: "sunny42" },
  trash: { day: "Tuesday", binLocation: "Side of the house" },
  rules: { quietFrom: "10 pm", quietTo: "7 am", guests: "Overnight guests up to 2 nights", pets: "No pets" },
  contacts: { emergency: "206-555-0142", onSite: "Marisol, unit 1" },
  laundry: { location: "Basement", hours: "8am-10pm" },
});
const FACTS = { houseInfo: HOUSE, knowledge: [] };

describe("matchResidentFastPath", () => {
  it.each([
    ["what's the wifi password?", "Wi-Fi: 4709A, password sunny42."],
    ["door code?", "Door code 4821, gate 77#."],
    ["what day is trash", "Trash day is Tuesday."],
    ["where do I put the bins?", "Trash day is Tuesday, bins: Side of the house."],
    ["where can I park", "Parking: Street parking, no permit needed."],
    ["when are quiet hours", "Quiet hours are 10 pm to 7 am."],
    ["can friends stay overnight?", "Guests: Overnight guests up to 2 nights."],
    ["are pets allowed", "Pets: No pets."],
    ["where is laundry", "Laundry: Basement, open 8am-10pm."],
    ["who do I call after hours?", "After hours 206-555-0142, on site Marisol, unit 1."],
  ])("%s", (text, reply) => {
    expect(matchResidentFastPath(text, FACTS)?.reply).toBe(reply);
  });

  it("answers in one GSM-7 segment", () => {
    for (const text of ["wifi password?", "door code", "trash day?"]) {
      const answer = matchResidentFastPath(text, FACTS);
      expect(answer && answer.reply.length).toBeLessThanOrEqual(160);
    }
  });

  it("answers several topics together when they fit one bubble", () => {
    expect(matchResidentFastPath("wifi and trash day?", FACTS)?.reply).toBe("Wi-Fi: 4709A, password sunny42. Trash day is Tuesday.");
  });

  it("never answers a door code without house details (pre move-in lock) or without a code on file", () => {
    expect(matchResidentFastPath("door code?", { houseInfo: null, knowledge: [] })).toBeNull();
    expect(matchResidentFastPath("door code?", { houseInfo: normalizeHouseInfo({ wifi: { network: "x", password: "y" } }), knowledge: [] })).toBeNull();
  });

  it("returns null when the fact is missing, so the agent can escalate", () => {
    expect(matchResidentFastPath("what day is recycling?", FACTS)).toBeNull();
    expect(matchResidentFastPath("is smoking allowed?", FACTS)).toBeNull();
    expect(matchResidentFastPath("wifi password?", { houseInfo: normalizeHouseInfo(null), knowledge: [] })).toBeNull();
  });

  it("leaves complaints, money, repairs and escalation topics to the agent", () => {
    for (const text of [
      "the wifi is down again",
      "wifi password? also my rent receipt",
      "the trash is overflowing and it's disgusting, I want to talk to a manager",
      "my roommate has a guest every night and it's harassment",
      "can I get my deposit back?",
      "door code? I'm locked out",
    ]) {
      expect(matchResidentFastPath(text, FACTS)).toBeNull();
    }
  });

  it("skips long, multi-question texts", () => {
    expect(matchResidentFastPath("wifi? trash? parking? door code?", FACTS)).toBeNull();
    expect(matchResidentFastPath(`wifi password ${"please ".repeat(30)}`, FACTS)).toBeNull();
  });

  it("answers from an approved Q&A that covers the question, and only then", () => {
    const knowledge = [
      { question: "Can I use the backyard grill?", answer: "Yes, grill is by the back deck. Clean it after use." },
      { question: "Where do I mail packages?", answer: "Lockers by the front door." },
    ];
    expect(matchResidentFastPath("can i use the grill", { houseInfo: HOUSE, knowledge })?.reply).toBe("Yes, grill is by the back deck. Clean it after use.");
    expect(matchResidentFastPath("can i use the sauna", { houseInfo: HOUSE, knowledge })).toBeNull();
    expect(matchResidentFastPath("what time is checkout", { houseInfo: HOUSE, knowledge })).toBeNull();
  });

  it("reads structured fields W11 may add, tolerating their absence", () => {
    // `normalizeHouseInfo` drops keys the schema does not name yet; W11 adds them, so build the bag directly.
    const info = { ...normalizeHouseInfo(null), trash: { day: "Tuesday", recyclingDay: "Friday" } };
    expect(matchResidentFastPath("what day is recycling", { houseInfo: info, knowledge: [] })?.reply).toBe("Recycling day is Friday, trash is Tuesday.");
  });
});

describe("isFastPathCandidate", () => {
  it("is a cheap shape check", () => {
    expect(isFastPathCandidate("wifi password?")).toBe(true);
    expect(isFastPathCandidate("can i use the grill")).toBe(true);
    expect(isFastPathCandidate("ok thanks")).toBe(false);
    expect(isFastPathCandidate("the sink is leaking")).toBe(false);
    expect(isFastPathCandidate("")).toBe(false);
  });
});

// --- scoping -------------------------------------------------------------------------------------
const scope = vi.hoisted(() => ({
  resolve: vi.fn(),
  owned: vi.fn(),
  entries: vi.fn(),
}));
vi.mock("@/lib/one-number/knowledge/scope.server", () => ({
  resolveResidentKnowledgeScope: scope.resolve,
  loadOwnedProperty: scope.owned,
}));
vi.mock("@/lib/one-number/knowledge/store.server", () => ({ loadAnswerableEntries: scope.entries }));

import { tryResidentFastPath } from "@/lib/one-number/resident-fast-path.server";

const ctx = {} as never;
const db = {} as never;

describe("tryResidentFastPath scoping", () => {
  beforeEach(() => {
    scope.resolve.mockReset();
    scope.owned.mockReset().mockResolvedValue({ id: "h1", workspaceId: "ws1", label: "5259", houseInfo: HOUSE });
    scope.entries.mockReset().mockResolvedValue([]);
  });

  const resident = { ok: true, scope: { viewer: "resident", workspaceId: "ws1", ownerUserId: "o1", allowedPropertyIds: ["h1"], focusPropertyId: "h1", audiences: ["all", "residents"], includeHouseInfo: true, includeHouseSecrets: true } };

  it("a current resident of the house gets the door code", async () => {
    scope.resolve.mockResolvedValue(resident);
    await expect(tryResidentFastPath(db, ctx, "door code?")).resolves.toMatchObject({ reply: "Door code 4821, gate 77#." });
    expect(scope.owned).toHaveBeenCalledWith(db, "o1", "h1");
  });

  it("before the check-in reveal the codes are withheld, the rest of the house still answers", async () => {
    scope.resolve.mockResolvedValue({ ok: true, scope: { ...resident.scope, includeHouseSecrets: false } });
    await expect(tryResidentFastPath(db, ctx, "door code?")).resolves.toBeNull();
    await expect(tryResidentFastPath(db, ctx, "what day is trash")).resolves.toMatchObject({ reply: "Trash day is Tuesday." });
  });

  it("before the move-in lock lifts, house details are never read", async () => {
    scope.resolve.mockResolvedValue({ ok: true, scope: { ...resident.scope, includeHouseInfo: false } });
    await expect(tryResidentFastPath(db, ctx, "door code?")).resolves.toBeNull();
    expect(scope.owned).not.toHaveBeenCalled();
  });

  it("no resolved house, an ambiguous scope or a house in another workspace answers nothing", async () => {
    scope.resolve.mockResolvedValue({ ok: false, reason: "needs_house" });
    await expect(tryResidentFastPath(db, ctx, "door code?")).resolves.toBeNull();
    scope.resolve.mockResolvedValue({ ok: true, scope: { ...resident.scope, focusPropertyId: null } });
    await expect(tryResidentFastPath(db, ctx, "door code?")).resolves.toBeNull();
    scope.resolve.mockResolvedValue(resident);
    scope.owned.mockResolvedValue({ id: "h1", workspaceId: "OTHER", label: "x", houseInfo: HOUSE });
    await expect(tryResidentFastPath(db, ctx, "door code?")).resolves.toBeNull();
  });

  it("only this house's and the team's approved entries are offered", async () => {
    scope.resolve.mockResolvedValue(resident);
    scope.entries.mockResolvedValue([
      { propertyId: "h2", question: "Can I use the grill?", answer: "Other house answer." },
      { propertyId: null, question: "Can I use the grill?", answer: "Team answer." },
    ]);
    await expect(tryResidentFastPath(db, ctx, "can i use the grill")).resolves.toMatchObject({ reply: "Team answer." });
  });

  it("never throws", async () => {
    scope.resolve.mockRejectedValue(new Error("db down"));
    await expect(tryResidentFastPath(db, ctx, "door code?")).resolves.toBeNull();
  });
});
