/**
 * One-number knowledge: ranking by keyword overlap. Pure, no embeddings.
 *
 * Score = distinct question tokens found in the candidate, weighted so a hit in
 * the entry's own question counts more than a hit in its answer, plus a small
 * bonus for a house-specific entry over a team-wide one so the house wins ties.
 */

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "have", "how", "i", "if", "in",
  "is", "it", "me", "my", "of", "on", "or", "our", "so", "that", "the", "there", "this", "to", "us", "we", "what",
  "when", "where", "which", "who", "will", "with", "you", "your", "about", "any", "get", "go", "im", "its", "much",
]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOP_WORDS.has(raw)) continue;
    // Crude plural fold so "dogs" matches "dog" and "codes" matches "code".
    const token = raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    out.push(token);
  }
  return out;
}

export type Rankable = {
  /** Text the question is matched against first (an entry's question, a section label). */
  primary: string;
  /** Secondary text (an entry's answer, a section's rows). */
  secondary: string;
  /** House-specific entries beat team-wide ones on a tie. */
  houseSpecific: boolean;
};

export function scoreCandidate(queryTokens: readonly string[], candidate: Rankable): number {
  if (queryTokens.length === 0) return 0;
  const primary = new Set(tokenize(candidate.primary));
  const secondary = new Set(tokenize(candidate.secondary));
  let score = 0;
  for (const token of new Set(queryTokens)) {
    if (primary.has(token)) score += 2;
    else if (secondary.has(token)) score += 1;
  }
  if (score > 0 && candidate.houseSpecific) score += 0.5;
  return score;
}

export function rankByOverlap<T>(
  question: string,
  items: readonly T[],
  toRankable: (item: T) => Rankable,
  options: { limit?: number; minScore?: number } = {},
): Array<{ item: T; score: number }> {
  const queryTokens = tokenize(question);
  const minScore = options.minScore ?? 1;
  return items
    .map((item, index) => ({ item, index, score: scoreCandidate(queryTokens, toRankable(item)) }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, options.limit ?? 5)
    .map(({ item, score }) => ({ item, score }));
}
