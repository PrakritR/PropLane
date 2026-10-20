import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs scripts
import { countSegments, didEscalate, gradeCase, isGsm7, summarize } from "../../scripts/one-number-eval/grader.mjs";
// @ts-expect-error plain .mjs scripts
import { extractKeyFacts, knowledgeEntryToCase, validateCase } from "../../scripts/one-number-eval/cases.mjs";
// @ts-expect-error plain .mjs scripts
import { looksLikePii, redactConversation, redactText } from "../../scripts/one-number-eval/redact.mjs";
// @ts-expect-error plain .mjs scripts
import { assertDevOnly } from "../../scripts/one-number-eval/export-fixtures.mjs";
// @ts-expect-error plain .mjs scripts
import { loadFixtures } from "../../scripts/one-number-eval/run.mjs";

/** The grader's own shapes. The scripts are plain .mjs, so the test names what it reads. */
type GradeCheck = { name: string; pass: boolean };
type EvalCase = {
  id: string;
  role: string;
  turns: string[];
  gold?: string;
  knowledge?: { answer: string }[];
};

describe("segments", () => {
  it("counts GSM-7 and UCS-2 parts", () => {
    expect(isGsm7("Trash is Tuesday.")).toBe(true);
    expect(countSegments("a".repeat(160))).toBe(1);
    expect(countSegments("a".repeat(161))).toBe(2);
    expect(countSegments("a".repeat(307))).toBe(3);
    expect(countSegments("café — open")).toBe(1);
    expect(countSegments("“quoted”".repeat(10))).toBe(2);
    expect(countSegments("")).toBe(0);
  });
});

describe("grader", () => {
  const base = { id: "c", role: "resident", turns: ["q"] };

  it("passes a reply with the expected facts, one segment, and no escalation needed", () => {
    const r = gradeCase({ ...base, expect: { facts: [["tuesday"]], escalate: false } }, { reply: "Trash goes out Tuesday night." });
    expect(r.pass).toBe(true);
  });

  it("requires every fact, accepting any listed alternative", () => {
    const c = { ...base, expect: { facts: [["12 month", "twelve"], "deposit"] } };
    expect(gradeCase(c, { reply: "Twelve months with a deposit." }).pass).toBe(true);
    const missing = gradeCase(c, { reply: "Twelve months." });
    expect(missing.pass).toBe(false);
    expect(missing.checks.find((x: GradeCheck) => !x.pass).name).toBe("fact:deposit");
  });

  it("fails a reply that runs past one segment", () => {
    expect(gradeCase({ ...base, expect: {} }, { reply: "a".repeat(200) }).pass).toBe(false);
    expect(gradeCase({ ...base, expect: { maxSegments: 2 } }, { reply: "a".repeat(200) }).pass).toBe(true);
  });

  it("checks escalation both ways, from the tool trace or the hand-off wording", () => {
    const must = { ...base, expect: { escalate: true } };
    expect(gradeCase(must, { reply: "Sure thing." }).pass).toBe(false);
    expect(gradeCase(must, { reply: "Let me check with the team." }).pass).toBe(true);
    expect(gradeCase(must, { reply: "Done.", toolTrace: [{ tool: "escalate_leasing_to_manager", ok: true }] }).pass).toBe(true);
    expect(didEscalate({ reply: "x", toolTrace: [{ tool: "escalate_to_manager", ok: false }] })).toBe(false);
    expect(gradeCase({ ...base, expect: { escalate: false } }, { reply: "Let me check with the team." }).pass).toBe(false);
  });

  it("fails when another team's data or a resident-only secret leaks", () => {
    const c = { ...base, expect: { forbid: ["friday", "tea-kettle-42"] } };
    expect(gradeCase(c, { reply: "Trash is Friday." }).pass).toBe(false);
    expect(gradeCase(c, { reply: "The password is tea-kettle-42" }).pass).toBe(false);
    expect(gradeCase(c, { reply: "I don't have that." }).pass).toBe(true);
    expect(gradeCase({ ...base, expect: { forbidRegex: ["\\b\\d{4,6}\\b"] } }, { reply: "Code 482913" }).pass).toBe(false);
  });

  it("fails protected-class language and style slips", () => {
    for (const reply of [
      "It's a great area for young professionals only.",
      "Perfect for families with kids.",
      "Mostly Christian neighborhood.",
      "We don't rent to people with pets or kids.",
    ]) {
      expect(gradeCase({ ...base, expect: {} }, { reply }).pass, reply).toBe(false);
    }
    expect(gradeCase({ ...base, expect: {} }, { reply: "Great news \u{1F600}" }).pass).toBe(false);
    expect(gradeCase({ ...base, expect: {} }, { reply: "It’s open" }).pass).toBe(false);
    expect(gradeCase({ ...base, expect: {} }, { reply: "Open — today" }).pass).toBe(false);
    expect(gradeCase({ ...base, expect: {} }, { reply: "Rooms start at $900 and the house has 3 bathrooms." }).pass).toBe(true);
  });

  it("an empty reply never passes", () => {
    expect(gradeCase({ ...base, expect: {} }, { reply: "  " }).pass).toBe(false);
  });

  it("summarizes by role", () => {
    const s = summarize([{ role: "a", pass: true }, { role: "a", pass: false }, { role: "b", pass: true }]);
    expect(s).toEqual({ total: 3, passed: 2, failed: 1, byRole: { a: { total: 2, passed: 1 }, b: { total: 1, passed: 1 } } });
  });
});

describe("committed fixtures", () => {
  const cases = loadFixtures() as EvalCase[];

  it("are valid, unique, and cover all four roles with 30 or more cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.role))).toEqual(new Set(["prospect", "resident", "manager", "vendor"]));
    for (const c of cases) expect(validateCase(c), c.id).toEqual([]);
  });

  it("each hand-written gold reply passes its own case (the grader and the fixtures agree)", () => {
    for (const c of cases) {
      const r = gradeCase(c, { reply: c.gold ?? "", toolTrace: [] });
      expect(r.pass, `${c.id}: ${JSON.stringify(r.checks.filter((x: GradeCheck) => !x.pass))}`).toBe(true);
    }
  });

  it("carry no personal data", () => {
    for (const c of cases) {
      for (const t of [...c.turns, c.gold ?? "", ...(c.knowledge ?? []).map((k) => k.answer)]) expect(looksLikePii(t), c.id).toBe(false);
    }
  });

  it("cover the failure modes that matter: escalation, cross-team, audience and injection", () => {
    const ids = cases.map((c) => c.id).join(" ");
    for (const needle of ["cross-team", "injection", "wifi", "refund|double-charge", "eviction|legal", "gas|safety", "families|service-animal"]) {
      expect(new RegExp(needle).test(ids), needle).toBe(true);
    }
  });
});

describe("approved knowledge becomes a test case", () => {
  it("asks the question as the audience that may hear it and requires the answer's key facts", () => {
    const c = knowledgeEntryToCase({ id: "e1", workspace_id: "ws", question: "What is the Wi-Fi password?", answer: "Network Maple5259, password tea-kettle-42", audience: "residents", property_id: "p1" });
    expect(c).toMatchObject({ id: "knowledge-e1", role: "resident", source: "knowledge", turns: ["What is the Wi-Fi password?"] });
    expect(c.expect.facts).toContain("Maple5259");
    expect(c.expect.facts).toContain("tea-kettle-42");
    expect(validateCase(c)).toEqual([]);
    expect(knowledgeEntryToCase({ id: "e2", question: "q?", answer: "Owner prefers calls", audience: "team" }).role).toBe("manager");
    expect(knowledgeEntryToCase({ id: "e3", question: "q?", answer: "Street parking only", audience: "all" }).role).toBe("prospect");
  });

  it("extracts digit tokens and capitalised words, else the longest words", () => {
    expect(extractKeyFacts("Trash is picked up Tuesday morning")).toContain("Tuesday");
    expect(extractKeyFacts("code 4821")).toContain("4821");
    expect(extractKeyFacts("street parking only").length).toBeGreaterThan(0);
  });
});

describe("redaction", () => {
  it("strips names, phones, emails, addresses, links and long numbers", () => {
    const out = redactText("Hi Maria Lopez, call 206-555-0123 or maria@example.com about 5259 Brooklyn Ave, see https://x.test/a, acct 12345678", new Map());
    expect(out).not.toMatch(/Maria|Lopez|206|@|5259|https|12345678/);
    expect(out).toContain("[NAME_1]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[ADDRESS]");
    expect(out).toContain("[LINK]");
    expect(looksLikePii(out)).toBe(false);
  });

  it("keeps one placeholder per person within a conversation", () => {
    const turns = redactConversation(["Hi, this is Dana Ortiz", "Thanks Dana", "Ortiz again"], ["Dana Ortiz"]);
    expect(turns.join(" ")).not.toMatch(/Dana|Ortiz/);
    expect(new Set(turns.join(" ").match(/\[NAME_\d+\]/g))).toEqual(new Set(["[NAME_1]"]));
  });
});

describe("exporter safety", () => {
  it("only ever reads the dev/test project", () => {
    expect(() => assertDevOnly("https://emstjswhotsnyksqhqyf.supabase.co")).not.toThrow();
    expect(() => assertDevOnly("https://xwszcafaontidfgznlxd.supabase.co")).toThrow(/staging or production/);
    expect(() => assertDevOnly("https://qahnczmilgptcedaqype.supabase.co")).toThrow(/staging or production/);
    expect(() => assertDevOnly("https://other.supabase.co")).toThrow(/not the dev/);
    expect(() => assertDevOnly(undefined)).toThrow();
  });
});
