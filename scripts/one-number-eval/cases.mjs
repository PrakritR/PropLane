/**
 * Fixture helpers shared by the exporter and the runner. Pure.
 */

const KINDS = new Set(["prospect", "resident", "manager", "vendor"]);

export function validateCase(testCase) {
  const problems = [];
  if (!testCase || typeof testCase !== "object") return ["not an object"];
  if (!testCase.id || typeof testCase.id !== "string") problems.push("id");
  if (!KINDS.has(testCase.role)) problems.push(`role "${testCase.role}"`);
  if (!Array.isArray(testCase.turns) || testCase.turns.length === 0 || testCase.turns.some((t) => typeof t !== "string" || !t.trim())) {
    problems.push("turns");
  }
  if (!testCase.expect || typeof testCase.expect !== "object") problems.push("expect");
  return problems;
}

/** Digits-bearing tokens and Capitalised words (not at sentence start), else the longest words. */
export function extractKeyFacts(answer, limit = 3) {
  const text = String(answer ?? "").trim();
  const tokens = text.split(/[\s,;()]+/).map((t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9\-]+$/g, "")).filter(Boolean);
  const digits = tokens.filter((t) => /\d/.test(t));
  const caps = tokens.filter((t, i) => i > 0 && /^[A-Z][a-z]{3,}$/.test(t));
  const picked = [...new Set([...digits, ...caps])].slice(0, limit);
  if (picked.length) return picked;
  return [...new Set(tokens.filter((t) => t.length >= 6).sort((a, b) => b.length - a.length))].slice(0, 2);
}

/**
 * An approved knowledge entry becomes a regression case: ask the entry's question as the audience
 * that may hear it, and require the answer's key facts. Entries for the team only are asked by a manager.
 */
export function knowledgeEntryToCase(entry) {
  const role = entry.audience === "team" ? "manager" : entry.audience === "all" ? "prospect" : "resident";
  return {
    id: `knowledge-${entry.id}`,
    role,
    source: "knowledge",
    workspace: entry.workspace_id ?? entry.workspaceId ?? "A",
    turns: [String(entry.question).trim()],
    knowledge: [
      {
        question: entry.question,
        answer: entry.answer,
        audience: entry.audience ?? "residents",
        propertyScoped: Boolean(entry.property_id ?? entry.propertyId),
      },
    ],
    expect: { facts: extractKeyFacts(entry.answer), escalate: false, maxSegments: 2 },
  };
}
