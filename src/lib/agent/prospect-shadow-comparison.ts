/** Pure, conservative comparison rules for a sealed prospect shadow run. */

export type ShadowEvidenceStatus = "grounded" | "ungrounded" | "unknown";
export type ShadowRepetitionStatus = "repeat" | "requested_repeat" | "correction" | "new" | "unknown";
export type ShadowToolStatus = "replayed" | "mismatch" | "unknown";

export type ShadowToolCall = { name: string; arguments: unknown };

export type ProspectShadowToolEvidence = {
  name: string;
  arguments: unknown;
  output: unknown;
};

export type ProspectShadowPrimaryEvidence = {
  /** Flat facts remain useful to existing consumers. Never infer them from prose. */
  supportedFacts: string[];
  /** Facts for one canonical property stay together so unrelated listings
   * cannot collectively make a reply look grounded. */
  supportedFactGroups: string[][];
};

export type ProspectShadowComparisonInput = {
  identity: ProspectShadowComparisonIdentity;
  primary: {
    output?: string | null;
    evidence?: {
      supportedFacts?: readonly string[];
      supportedFactGroups?: readonly (readonly string[])[];
      unsupportedClaims?: readonly string[];
      toolCalls?: readonly ShadowToolCall[];
    };
  };
  shadow: {
    output?: string | null;
    toolCalls?: readonly ShadowToolCall[];
  };
  repetitionEvidence?: {
    priorOutputs?: readonly string[];
    explicitRepeat?: boolean;
    correction?: boolean;
    newDetail?: boolean;
  };
};

export type ProspectShadowComparisonIdentity = {
  burstId?: string;
  burstRevision?: number;
  promptId?: string;
  promptHash?: string;
  release?: string;
  primaryProvider?: string;
  primaryModel?: string;
  shadowProvider: "openai";
  shadowModel: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameText(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && left.trim() === right.trim();
}

/**
 * Project only typed, successful tool results into facts the shadow scorer can
 * check. Each group is bound to exactly one canonical property. A list search
 * may discover candidates, but it never proves an answer about one of them.
 */
export function projectProspectShadowPrimaryEvidence(
  evidence: readonly ProspectShadowToolEvidence[],
): ProspectShadowPrimaryEvidence {
  const groups: string[][] = [];
  for (const item of evidence) {
    const input = record(item.arguments);
    const output = record(item.output);
    if (!input || !output) continue;

    if (item.name === "get_listing_details") {
      const listing = record(output.listing);
      const propertyId = text(input.propertyId);
      if (output.found !== true || !listing || !propertyId || !sameText(listing.propertyId, propertyId)) continue;
      const title = text(listing.title);
      if (!title) continue;
      const facts = [title];
      const available = text(listing.available);
      const rent = text(listing.rentLabel);
      const address = text(listing.address);
      if (available) facts.push(`${title} is available ${available}`);
      if (rent) facts.push(`${title} rent is ${rent}`);
      if (address) facts.push(`${title} address is ${address}`);
      groups.push(facts);
      continue;
    }

    if (item.name === "list_open_tour_slots") {
      const propertyId = text(input.propertyId);
      const resolution = text(output.resolution);
      const slots = Array.isArray(output.slots) ? output.slots : null;
      if (!propertyId || !resolution || !slots) continue;
      // The tool intentionally exposes canonical IDs, not a display title.
      // Keep its statements explicitly keyed to that ID.
      const facts = [`${propertyId} tour availability is ${resolution}`];
      if (resolution === "resolved" && slots.length === 0) facts.push(`${propertyId} has no open tour slots`);
      groups.push(facts);
    }
  }
  return {
    supportedFacts: groups.flat(),
    supportedFactGroups: groups,
  };
}

export type ProspectShadowComparison = {
  identity: ProspectShadowComparisonIdentity;
  grounding: ShadowEvidenceStatus;
  repetition: ShadowRepetitionStatus;
  toolCorrectness: ShadowToolStatus;
};

/** Classify only explicit wording. The caller supplies confirmed prior outputs;
 * missing history remains unknown instead of being promoted into a pass. */
export function prospectRepetitionEvidence(
  inboundText: string,
  priorOutputs: readonly string[],
): NonNullable<ProspectShadowComparisonInput["repetitionEvidence"]> {
  const text = normalized(inboundText);
  const explicitRepeat = /\b(repeat|again|say that again|send that again|what did you say)\b/.test(text);
  const correction = /\b(actually|correction|i meant|to clarify|not what i meant)\b/.test(text);
  return {
    priorOutputs: [...priorOutputs],
    explicitRepeat,
    correction,
    // Nonempty text alone is not proof that the prospect supplied a new fact.
    newDetail: false,
  };
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, i) => sameValue(item, right[i]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).sort();
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]));
}

/**
 * Grounding is literal proof, not a bag-of-words similarity score. In
 * particular, retain every non-whitespace character: `-$1,200`, `>$1,200`,
 * and `$1,200` are different assertions, as are URLs with different paths.
 */
function normalizedAssertion(value: string): string {
  return value.trim().replace(/\s+/g, " ")
    .split(/(https?:\/\/[^\s]+)/gi)
    .map((part) => /^https?:\/\//i.test(part) ? part : part.toLocaleLowerCase())
    .join("");
}

function fullySupportedByAssertions(reply: string, facts: readonly string[]): boolean {
  const assertions = [...new Set(facts.map(normalizedAssertion).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  const source = normalizedAssertion(reply);
  if (!source || !assertions.length) return false;

  const consume = (remaining: string): boolean => {
    for (const assertion of assertions) {
      if (!remaining.startsWith(assertion)) continue;
      const rest = remaining.slice(assertion.length);
      if (!rest || rest === ".") return true;
      // A whole supported assertion may follow a normal sentence boundary.
      // Do not accept conjunctions, commas, semicolons, or arbitrary filler.
      const separator = rest.match(/^[.!?]\s+/);
      if (separator && consume(rest.slice(separator[0].length))) return true;
    }
    return false;
  };

  return consume(source);
}

function containsFactAssertion(reply: string, facts: readonly string[]): boolean {
  const source = normalizedAssertion(reply);
  return facts.some((fact) => source.includes(normalizedAssertion(fact)));
}

const numericToken = /\$?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g;

/** Treat only conventional thousands grouping and insignificant decimal zeros
 * as the same literal amount. Signs, operators, currency, percentages, and
 * malformed number spellings deliberately remain distinct. */
function normalizedStandardNumber(value: string): string | null {
  const match = /^(\$)?(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(\.\d+)?(%)?$/.exec(value);
  if (!match) return null;
  const [, currency = "", integer, fraction = "", percent = ""] = match;
  const normalizedFraction = fraction.replace(/0+$/, "");
  return `${currency}${integer.replaceAll(",", "")}${normalizedFraction === "." ? "" : normalizedFraction}${percent}`;
}

function sameStandardNumber(left: string, right: string): boolean {
  const normalizedLeft = normalizedStandardNumber(left);
  const normalizedRight = normalizedStandardNumber(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

/** Keep the prior narrow numeric-mismatch signal, but only for otherwise
 * literal assertions. Prefixes such as minus signs and comparison operators
 * intentionally fail this check so unsupported syntax remains unknown. */
function hasExactNumericMismatch(reply: string, facts: readonly string[]): boolean {
  const source = normalizedAssertion(reply).replace(/\.$/, "");
  for (const fact of facts) {
    const assertion = normalizedAssertion(fact).replace(/\.$/, "");
    const sourceNumbers = source.match(numericToken);
    const factNumbers = assertion.match(numericToken);
    if (!sourceNumbers?.length || sourceNumbers.length !== factNumbers?.length) continue;
    if (source.replace(numericToken, "#") !== assertion.replace(numericToken, "#")) continue;
    if (sourceNumbers.some((value, index) => value.startsWith("$") !== factNumbers[index]?.startsWith("$"))) continue;
    if (sourceNumbers.some((value, index) => value !== factNumbers[index] && !sameStandardNumber(value, factNumbers[index] ?? ""))) return true;
  }
  return false;
}

function hasAddedNumericClaim(reply: string, facts: readonly string[]): boolean {
  if (!containsFactAssertion(reply, facts)) return false;
  const source = normalizedAssertion(reply);
  const modifiedNumber = /(?:[-+−<>≤≥]=?\s*[$€£¥]?|[$€£¥]\s*[-+−<>≤≥]=?)\s*\d/u;
  const negatedNumber = /\b(?:no|not|never)\b[^.!?]*[$€£¥]?\s*\d/u;
  const unsupportedCurrency = /[€£¥]\s*\d/u;
  if (modifiedNumber.test(source) || negatedNumber.test(source) || unsupportedCurrency.test(source)) return false;
  const supported = facts.flatMap((fact) => normalizedAssertion(fact).match(numericToken) ?? []);
  return (source.match(numericToken) ?? []).some((value) => !supported.some((factValue) => value === factValue || sameStandardNumber(value, factValue)));
}

function grounding(input: ProspectShadowComparisonInput): ShadowEvidenceStatus {
  const output = input.shadow.output?.trim();
  if (!output) return "unknown";
  const evidence = input.primary.evidence;
  if (!evidence) return "unknown";
  const hasPropertyGroups = Boolean(evidence.supportedFactGroups?.length);
  const groups = evidence.supportedFactGroups?.map((group) => [...group])
    ?? (evidence.supportedFacts?.length ? [[...evidence.supportedFacts]] : []);
  if (!groups.length) return "unknown";
  if (!hasPropertyGroups) {
    const facts = groups[0] ?? [];
    if (fullySupportedByAssertions(output, facts)) return "grounded";
    return (hasExactNumericMismatch(output, facts) || hasAddedNumericClaim(output, facts))
      ? "ungrounded"
      : "unknown";
  }
  const groupAssertionMatches = groups.map((group) => {
    const assertions = group.length > 1 ? group.slice(1) : group;
    return containsFactAssertion(output, assertions);
  });
  // Combining independently supported properties is outside this deterministic
  // scorer's proof boundary. Do not let one listing substantiate another.
  if (groupAssertionMatches.filter(Boolean).length > 1) return "unknown";

  for (const [index, group] of groups.entries()) {
    const anchor = group[0];
    const assertionMatched = groupAssertionMatches[index];
    const anchorMatched = Boolean(anchor && containsFactAssertion(output, [anchor]));
    if (!assertionMatched && !anchorMatched) continue;
    const assertions = group.length > 1 ? group.slice(1) : group;
    if (fullySupportedByAssertions(output, assertions)) return "grounded";
    if (hasExactNumericMismatch(output, assertions) || hasAddedNumericClaim(output, assertions)) return "ungrounded";
  }

  return "unknown";
}

function repetition(input: ProspectShadowComparisonInput): ShadowRepetitionStatus {
  const output = input.shadow.output?.trim();
  const evidence = input.repetitionEvidence;
  if (!output || !evidence?.priorOutputs?.length) return "unknown";
  const repeated = evidence.priorOutputs.some((prior) => normalized(prior) === normalized(output));
  if (repeated && evidence.explicitRepeat) return "requested_repeat";
  if (repeated) return "repeat";
  if (evidence.correction) return "correction";
  if (evidence.newDetail) return "new";
  return "unknown";
}

function toolCorrectness(input: ProspectShadowComparisonInput): ShadowToolStatus {
  const calls = input.shadow.toolCalls ?? [];
  const evidence = input.primary.evidence?.toolCalls ?? [];
  if (!calls.length || !evidence.length) return "unknown";
  return calls.every((call) => evidence.some((item) => item.name === call.name && sameValue(item.arguments, call.arguments)))
    ? "replayed"
    : "mismatch";
}

export function compareProspectShadow(input: ProspectShadowComparisonInput): ProspectShadowComparison {
  return {
    identity: input.identity,
    grounding: grounding(input),
    repetition: repetition(input),
    toolCorrectness: toolCorrectness(input),
  };
}
