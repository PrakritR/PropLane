import { toGsm7 } from "@/lib/one-number/segments";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * "Text us" on a listing and on a room (design-1112 §3.2). Pure: the caller passes the ONE number it was given
 * (`getPublicTextingConfig().phone`, the PropLane line) and the listing facts; nothing here picks or invents a
 * number, and a value that is not a deliverable number yields no link at all.
 *
 * The prefilled body names the home (and the room) in plain words and ends with the property's entry code in
 * parentheses. The code is how the inbound router knows which home the text is about even when the words are
 * ambiguous (`resolveInboundContext` reads a trailing `(CODE)`), so it must stay the last thing in the body.
 */

const LABEL_MAX = 70;
const ENTRY_CODE = /^[A-Z0-9]{3,16}$/;

function clean(value: string | null | undefined, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

export function textUsBody(input: { label: string; roomLabel?: string | null; code: string | null }): string {
  const label = clean(input.label, LABEL_MAX);
  const room = clean(input.roomLabel, 40);
  const subject = [label, room].filter(Boolean).join(", ");
  const code = typeof input.code === "string" && ENTRY_CODE.test(input.code.trim().toUpperCase()) ? input.code.trim().toUpperCase() : null;
  const lead = subject ? `Hi, I'm interested in ${subject}.` : "Hi, I'm interested in a home I saw on PropLane.";
  return toGsm7(code ? `${lead} (${code})` : lead);
}

/** `sms:<number>?&body=...`: the `?&` form opens a prefilled text on both iOS and Android. Empty for a bad number. */
export function textUsHref(numberE164: string, body: string): string {
  const number = normalizeE164(numberE164);
  if (!number) return "";
  return `sms:${number}?&body=${encodeURIComponent(body)}`;
}
