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

function grounding(input: ProspectShadowComparisonInput): ShadowEvidenceStatus {
  const output = input.shadow.output?.trim();
  if (!output) return "unknown";
  const evidence = input.primary.evidence;
  if (!evidence) return "unknown";
  const groups = evidence.supportedFactGroups?.map((group) => [...group])
    ?? (evidence.supportedFacts?.length ? [[...evidence.supportedFacts]] : []);
  if (!groups.length) return "unknown";
  const reply = normalized(output);
  const factualTokens = output.match(/https?:\/\/\S+|\$?\d[\d,.]*(?:%|\b)/g) ?? [];
  const stopwords = new Set(["a", "an", "and", "are", "at", "for", "in", "is", "it", "of", "on", "the", "to"]);
  let mentionsSupportedFact = false;
  let hasUnsupportedNumber = false;
  for (const group of groups) {
    const facts = group.map(normalized).filter(Boolean);
    if (!facts.some((fact) => reply.includes(fact))) continue;
    mentionsSupportedFact = true;
    const evidenceText = facts.join(" ");
    if (factualTokens.some((token) => !evidenceText.includes(normalized(token)))) {
      hasUnsupportedNumber = true;
      continue;
    }
    const evidenceWords = new Set(evidenceText.split(/[^\p{L}\p{N}$]+/u).filter(Boolean));
    const unsupportedWords = reply.split(/[^\p{L}\p{N}$]+/u)
      .filter((word) => word.length > 1 && !stopwords.has(word) && !evidenceWords.has(word));
    if (unsupportedWords.length === 0) return "grounded";
  }
  return hasUnsupportedNumber && mentionsSupportedFact ? "ungrounded" : "unknown";
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
