import { EMERGENCY_TERMS, HUMAN_KEYWORDS } from "@/lib/one-number/contracts";

/** STOP / START / HELP are NOT classified here: the inbound route handles them as it always has. */
export type SharedLineTextKeyword = "HUMAN" | "EMERGENCY";

/** Politeness tail that does not change "HUMAN": "human please", "agent pls", "person!". */
const POLITE_TAIL = /[^A-Z0-9]+(PLEASE|PLS|PLZ|THANKS|THANK YOU)$/;
const EDGE_PUNCTUATION = /^[^A-Z0-9]+|[^A-Z0-9]+$/g;

function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One regex per term: whole-word on both sides, spaces in the term match any whitespace run. */
const EMERGENCY_PATTERNS: readonly RegExp[] = EMERGENCY_TERMS.map(
  (term) => new RegExp(`(?<![a-z0-9])${escapeRegex(term).replace(/ /g, "\\s+")}(?![a-z0-9])`, "i"),
);

function isHumanKeyword(body: string): boolean {
  const upper = body.trim().toUpperCase().replace(EDGE_PUNCTUATION, "");
  return HUMAN_KEYWORDS.has(upper.replace(POLITE_TAIL, "").replace(EDGE_PUNCTUATION, ""));
}

/**
 * HUMAN: the whole body is one human keyword (optionally with "please" or
 * punctuation). EMERGENCY: any emergency term as a whole word ("fire" never
 * matches "firewood" or "fired"; "smoke" alone counts). Anything else: null.
 */
export function classifySharedLineKeyword(body: string | null | undefined): SharedLineTextKeyword | null {
  const text = String(body ?? "");
  if (!text.trim()) return null;
  if (isHumanKeyword(text)) return "HUMAN";
  if (EMERGENCY_PATTERNS.some((pattern) => pattern.test(text))) return "EMERGENCY";
  return null;
}
