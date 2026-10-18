import { smsSegmentCount, toGsm7 } from "@/lib/one-number/segments";

/**
 * Text-message "feel": one long reply becomes up to three short bubbles, the
 * way a person texts. Pure (no I/O) so the rules are unit-tested.
 *
 * Rules, in order:
 *  1. Markdown is stripped. A text message has no formatting, so asterisks and
 *     backticks would arrive as literal noise.
 *  2. The text is made GSM-7 (curly quotes, long dashes, emoji out) unless the
 *     texter used an emoji first (`allowEmoji`), in which case emoji are kept.
 *  3. It is cut on sentence boundaries and packed greedily into bubbles of at
 *     most one segment (160 GSM-7 characters; 70 when emoji are kept). Bubble 1
 *     is therefore the answer or acknowledgement, never a preamble.
 *  4. A URL is never split: cuts fall between whitespace-separated tokens, and a
 *     URL longer than a segment rides alone in its bubble.
 *  5. At most {@link MAX_BUBBLES}. When the text needs more, the overflow stays
 *     in the LAST bubble (that bubble may then be longer than one segment);
 *     content is never dropped.
 */

export const MAX_BUBBLES = 3;
/** One GSM-7 segment. */
export const BUBBLE_MAX_CHARS = 160;

const EMOJI_RUN = /(\p{Extended_Pictographic}(?:[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]|\p{Extended_Pictographic})*)/gu;
const URL_TOKEN = /^(?:\(|\[|<)?(?:https?:\/\/|www\.)\S+/i;
const NON_TERMINAL = new Set([
  "mr.", "mrs.", "ms.", "dr.", "st.", "ave.", "apt.", "no.", "jr.", "sr.", "vs.", "etc.", "inc.", "ste.", "rd.", "blvd.",
  "e.g.", "i.e.", "a.m.", "p.m.", "u.s.",
]);

/** True when `text` carries an emoji (the texter used one, so a reply may mirror it). */
export function textHasEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}/u.test(String(text ?? ""));
}

/** Remove markdown a text message would show as literal symbols. Links keep their URL. */
export function stripMarkdown(input: string): string {
  let out = String(input ?? "").replace(/\r\n?/g, "\n");
  out = out.replace(/```[a-z0-9]*\n?([\s\S]*?)```/gi, "$1");
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string) => alt);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label: string, url: string) =>
    label.trim() === url.trim() || /^https?:\/\//i.test(label.trim()) ? url : `${label.trim()}: ${url}`,
  );
  out = out.replace(/`([^`\n]+)`/g, "$1");
  out = out.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  out = out.replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,!?;:])/g, "$1$2");
  out = out.replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=$|[\s).,!?;:])/g, "$1$2");
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^\s*[*+•]\s+/gm, "- ");
  out = out.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, "");
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/** GSM-7 everything except emoji runs when `keepEmoji`. */
function normalizeText(text: string, keepEmoji: boolean): string {
  if (!keepEmoji) return toGsm7(text);
  return text
    .split(EMOJI_RUN)
    .map((part, index) => (index % 2 === 1 ? part : toGsm7(part)))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isUrlToken(token: string): boolean {
  return URL_TOKEN.test(token);
}

type Sentence = { text: string; newlineBefore: boolean };

function endsSentence(token: string, next: string | undefined): boolean {
  if (next === undefined || isUrlToken(token)) return false;
  const bare = token.replace(/["')\]]+$/, "");
  if (!/[.!?]$/.test(bare)) return false;
  if (/[!?]$/.test(bare)) return true;
  const lower = bare.toLowerCase();
  if (NON_TERMINAL.has(lower) || /^(?:[a-z]\.){2,}$/i.test(bare) || /^\d{1,2}\.$/.test(bare)) return false;
  const first = next.replace(/^["'(\[]+/, "").charAt(0);
  return first !== "" && first === first.toUpperCase() && /[A-Z0-9]/.test(first);
}

function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  lines.forEach((line, lineIndex) => {
    const tokens = line.split(/\s+/).filter(Boolean);
    let current: string[] = [];
    let first = true;
    tokens.forEach((token, i) => {
      current.push(token);
      if (endsSentence(token, tokens[i + 1])) {
        sentences.push({ text: current.join(" "), newlineBefore: first && lineIndex > 0 });
        current = [];
        first = false;
      }
    });
    if (current.length) sentences.push({ text: current.join(" "), newlineBefore: first && lineIndex > 0 });
  });
  return sentences;
}

const fits = (text: string): boolean => smsSegmentCount(text) <= 1;

/** One over-long sentence cut at a clause break near the end of a segment, else at a word. */
function splitLong(sentence: string): string[] {
  const tokens = sentence.split(/\s+/).filter(Boolean);
  const pieces: string[] = [];
  let rest = tokens;
  while (rest.length) {
    if (isUrlToken(rest[0]!) && !fits(rest[0]!)) {
      pieces.push(rest[0]!);
      rest = rest.slice(1);
      continue;
    }
    let take = 0;
    let candidate = "";
    while (take < rest.length) {
      const next = candidate ? `${candidate} ${rest[take]}` : rest[take]!;
      if (!fits(next)) break;
      candidate = next;
      take += 1;
    }
    if (take === 0) take = 1; // a single token wider than a segment (never a URL here) goes alone
    if (take < rest.length) {
      // Prefer the last clause break in the back half of the segment.
      const floor = Math.floor(take * 0.4);
      for (let i = take - 1; i >= floor && i > 0; i -= 1) {
        if (/[,;:]$/.test(rest[i - 1]!)) {
          take = i;
          break;
        }
      }
    }
    pieces.push(rest.slice(0, take).join(" "));
    rest = rest.slice(take);
  }
  return pieces;
}

export type SplitBubblesOptions = {
  /** The texter used an emoji, so the reply may keep its own. Default false. */
  allowEmoji?: boolean;
  /** Cap on bubbles; overflow stays in the last one. Default {@link MAX_BUBBLES}. */
  maxBubbles?: number;
};

/** Split a reply into at most three phone-sized bubbles. Returns `[]` for an empty reply. */
export function splitIntoBubbles(text: string, options: SplitBubblesOptions = {}): string[] {
  const cap = Math.max(1, Math.floor(options.maxBubbles ?? MAX_BUBBLES));
  const cleaned = normalizeText(stripMarkdown(text), options.allowEmoji === true);
  if (!cleaned) return [];
  if (fits(cleaned) && !cleaned.includes("\n\n")) return [cleaned.replace(/\n+/g, "\n")];

  const bubbles: string[] = [];
  let current = "";
  const push = () => {
    if (current) bubbles.push(current);
    current = "";
  };
  for (const sentence of splitSentences(cleaned)) {
    const pieces = fits(sentence.text) ? [sentence.text] : splitLong(sentence.text);
    pieces.forEach((piece, index) => {
      const joiner = index === 0 && sentence.newlineBefore ? "\n" : " ";
      if (!current) {
        current = piece;
        return;
      }
      const candidate = `${current}${joiner}${piece}`;
      if (fits(candidate)) {
        current = candidate;
      } else {
        push();
        current = piece;
      }
    });
  }
  push();

  while (bubbles.length > cap) {
    const last = bubbles.pop()!;
    bubbles[bubbles.length - 1] = `${bubbles[bubbles.length - 1]} ${last}`;
  }
  return bubbles;
}
