import { describe, expect, it } from "vitest";
import { rankByOverlap, scoreCandidate, tokenize } from "@/lib/one-number/knowledge/ranking";
import { classifyTopic, detectAlwaysEscalate, normalizeTopic, REPLY_TOPICS } from "@/lib/one-number/knowledge/topics";
import { ALWAYS_ESCALATE_TOPICS } from "@/lib/one-number/contracts";

describe("tokenize", () => {
  it("drops stop words and folds plurals", () => {
    expect(tokenize("What are the trash days?")).toEqual(["trash", "day"]);
    expect(tokenize("Dogs and cats")).toEqual(["dog", "cat"]);
  });
});

describe("ranking by keyword overlap", () => {
  const entries = [
    { id: "wifi", q: "What is the wifi password?", a: "Network Maple, password tea-kettle", house: true },
    { id: "trash", q: "What day is trash pickup?", a: "Tuesday morning", house: true },
    { id: "parking", q: "Is there parking?", a: "Street parking only", house: false },
  ];
  const rank = (question: string) =>
    rankByOverlap(question, entries, (e) => ({ primary: e.q, secondary: e.a, houseSpecific: e.house })).map((r) => r.item.id);

  it("puts the entry that matches the question first", () => {
    expect(rank("whats the wifi password")[0]).toBe("wifi");
    expect(rank("which day do they pick up trash")[0]).toBe("trash");
  });

  it("returns nothing when no word overlaps", () => {
    expect(rank("can I keep a kayak in the yard")).toEqual([]);
  });

  it("counts a question hit above an answer hit, and a house entry above a team-wide tie", () => {
    const tokens = tokenize("parking");
    const inQuestion = scoreCandidate(tokens, { primary: "parking", secondary: "", houseSpecific: false });
    const inAnswer = scoreCandidate(tokens, { primary: "", secondary: "street parking", houseSpecific: false });
    expect(inQuestion).toBeGreaterThan(inAnswer);
    const house = scoreCandidate(tokens, { primary: "parking", secondary: "", houseSpecific: true });
    expect(house).toBeGreaterThan(inQuestion);
  });

  it("limits and orders deterministically", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: i, text: "parking" }));
    const out = rankByOverlap("parking", many, (m) => ({ primary: m.text, secondary: "", houseSpecific: false }), { limit: 3 });
    expect(out.map((r) => r.item.id)).toEqual([0, 1, 2]);
  });
});

describe("topics", () => {
  it("classifies common questions", () => {
    expect(classifyTopic("Can I tour on Saturday?")).toBe("tour");
    expect(classifyTopic("Where do I park my car")).toBe("parking");
    expect(classifyTopic("what is the wifi password")).toBe("utilities");
    expect(classifyTopic("how much is rent")).toBe("payment");
    expect(classifyTopic("how do I apply")).toBe("application");
    expect(classifyTopic("hello there")).toBe("other");
  });

  it("only ever yields a known topic", () => {
    for (const text of ["x", "tour", "parking lot", "random words here"]) {
      expect(REPLY_TOPICS).toContain(classifyTopic(text));
    }
    expect(normalizeTopic("general")).toBe("other");
    expect(normalizeTopic("tour")).toBe("tour");
  });

  it("flags money, legal, safety and fair housing questions", () => {
    expect(detectAlwaysEscalate("I want a refund for the double charge")).toBe("money");
    expect(detectAlwaysEscalate("can he evict me")).toBe("legal");
    expect(detectAlwaysEscalate("it smells like gas")).toBe("safety");
    expect(detectAlwaysEscalate("do you rent to families with children")).toBe("fair_housing");
    expect(detectAlwaysEscalate("what day is trash")).toBeNull();
    for (const topic of ALWAYS_ESCALATE_TOPICS) expect(typeof topic).toBe("string");
  });
});
