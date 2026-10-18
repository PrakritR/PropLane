/**
 * PII stripping for exported eval fixtures. Pure.
 *
 * Names become [NAME_n], phones [PHONE], emails [EMAIL], street addresses [ADDRESS], links [LINK],
 * long digit runs (codes, account numbers) [NUMBER]. The same name maps to the same placeholder
 * inside one conversation so a fixture still reads as a conversation.
 */

const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const ADDRESS = /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][A-Za-z0-9]*\s+){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Ter|Terrace|Hwy|Highway)\b\.?(?:\s+(?:Apt|Unit|#)\s*\w+)?/gi;
const NUMBER_RUN = /\b\d{5,}\b/g;
const INTRO = /\b(?:my name is|i am|i'm|this is|it's|its|hi|hello|hey|thanks|thank you|dear|from)\s+([A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15})?)\b/g;

export function redactText(text, names, knownNames = []) {
  let out = String(text ?? "");
  const place = (raw) => {
    const key = raw.trim().toLowerCase();
    if (!names.has(key)) names.set(key, `[NAME_${names.size + 1}]`);
    return names.get(key);
  };
  for (const known of knownNames) {
    const parts = String(known).split(/\s+/).filter((p) => p.length > 1);
    for (const part of [String(known).trim(), ...parts]) {
      if (!part) continue;
      out = out.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), () => place(String(known).trim()));
    }
  }
  out = out.replace(INTRO, (match, name) => match.replace(name, place(name)));
  return out
    .replace(EMAIL, "[EMAIL]")
    .replace(URL_RE, "[LINK]")
    .replace(ADDRESS, "[ADDRESS]")
    .replace(PHONE, "[PHONE]")
    .replace(NUMBER_RUN, "[NUMBER]");
}

/** Redact every turn of one conversation with a shared name table. */
export function redactConversation(turns, knownNames = []) {
  const names = new Map();
  return turns.map((t) => redactText(t, names, knownNames));
}

/** True when a string still looks like it holds PII. Used as the exporter's last gate. */
export function looksLikePii(text) {
  const s = String(text ?? "");
  return new RegExp(EMAIL.source).test(s) || new RegExp(PHONE.source).test(s) || new RegExp(URL_RE.source, "i").test(s);
}
