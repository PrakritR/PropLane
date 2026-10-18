import { estimateSmsSegments } from "@/lib/sms/number-registration-policy";

/**
 * Segment guard for AI-written SMS replies. A single curly quote, long dash,
 * ellipsis or emoji flips a text from GSM-7 (160 chars/segment) to UCS-2
 * (70 chars/segment) and more than doubles its cost. `toGsm7` rewrites those
 * characters to plain equivalents; it never changes the meaning of a reply.
 */

const GSM_7_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ),
);
const GSM_7_EXTENSION = new Set(Array.from("\f^{}\\[~]|€"));

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’‚‛′´`]/g, "'"],
  [/[“”„‟″«»]/g, '"'],
  [/[‐‑‒–—―−﹘﹣－]/g, "-"],
  [/…/g, "..."],
  [/[  -   　]/g, " "],
  [/[•·●▪]/g, "-"],
  [/[​-‍⁠﻿]/g, ""],
];

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️⃣]/gu;

function inGsm7(character: string): boolean {
  return GSM_7_BASIC.has(character) || GSM_7_EXTENSION.has(character);
}

/** Rewrite `text` so it encodes as GSM-7. Idempotent; plain ASCII passes through untouched. */
export function toGsm7(text: string): string {
  let out = String(text ?? "");
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  out = out.replace(EMOJI, "");
  let rebuilt = "";
  for (const character of out) {
    if (inGsm7(character)) {
      rebuilt += character;
      continue;
    }
    // Accented letters outside the GSM table lose the accent; anything else is dropped.
    const folded = character.normalize("NFD").replace(/[̀-ͯ]/g, "");
    for (const part of folded) if (inGsm7(part)) rebuilt += part;
  }
  return rebuilt.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

/** Billed SMS segments for `text` exactly as it would be sent (0 for an empty body). */
export function smsSegmentCount(text: string): number {
  return estimateSmsSegments(String(text ?? "")).segmentCount;
}

/** True when `text` already encodes as GSM-7. */
export function isGsm7(text: string): boolean {
  for (const character of String(text ?? "")) if (!inGsm7(character)) return false;
  return true;
}
