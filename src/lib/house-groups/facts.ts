import { toGsm7 } from "@/lib/one-number/segments";
import { PRIVATE_FACT_NOTE, answerText } from "./copy";

/**
 * Turns a knowledge lookup into what the RA may say in a GROUP. The group holds housemates, so:
 * a door code, lockbox, gate or alarm code, a Wi-Fi password or any access detail is never posted
 * there (it goes to the asker in a private text); nothing with an amount or a price; nothing about
 * a particular resident. Pure.
 */

export type LookupLike = {
  found: boolean;
  mustEscalate: string | null;
  answers: { question: string; answer: string }[];
  houseDetails: { house: string; section: string; rows: { label: string; value: string }[] }[];
};

const SECRET_LABEL = /(pass(word|code|phrase)?|pin\b|\bcode\b|lock ?box|combination|\bkey\b|keys|gate|alarm|garage|entry|access)/i;
const SECRET_SECTION = /(access|entry|door|lock|key|security)/i;
const MONEY_LABEL = /(rent|deposit|fee|price|cost|amount|charge|fine|late)/i;
const AMOUNT_VALUE = /(\$\s?\d|\d\s?(usd|dollars)\b)/i;

const MAX_GROUP_CHARS = 280;

export type FactReply =
  | { kind: "group"; text: string }
  /** The group gets a short note; the secret goes to the asker alone. */
  | { kind: "private"; groupText: string; privateText: string }
  /** Money, legal, safety or fair housing: not for the group; hand it to the team and follow up directly. */
  | { kind: "escalate" }
  /** Nothing approved covers it: say so and tell the team. */
  | { kind: "unknown" };

function isSecretRow(section: string, row: { label: string; value: string }): boolean {
  return SECRET_LABEL.test(row.label) || SECRET_SECTION.test(section);
}

function isMoneyRow(row: { label: string; value: string }): boolean {
  return MONEY_LABEL.test(row.label) || AMOUNT_VALUE.test(row.value);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_GROUP_CHARS ? `${flat.slice(0, MAX_GROUP_CHARS - 3).trimEnd()}...` : flat;
}

export function composeFactReply(result: LookupLike, firstName: string): FactReply {
  if (result.mustEscalate) return { kind: "escalate" };

  // Approved Q&A entries win: a manager wrote them for exactly this question.
  const entry = result.answers.find((a) => !AMOUNT_VALUE.test(a.answer));
  if (entry) return { kind: "group", text: answerText(firstName, clip(entry.answer)) };

  const shown: string[] = [];
  const secret: string[] = [];
  for (const hit of result.houseDetails) {
    const open = hit.rows.filter((r) => !isSecretRow(hit.section, r) && !isMoneyRow(r));
    const closed = hit.rows.filter((r) => isSecretRow(hit.section, r) && !isMoneyRow(r));
    if (open.length > 0) shown.push(`${hit.section}: ${open.map((r) => `${r.label} ${r.value}`).join("; ")}`);
    if (closed.length > 0) secret.push(`${hit.section}: ${closed.map((r) => `${r.label} ${r.value}`).join("; ")}`);
    if (shown.length > 0 || secret.length > 0) break; // the best-ranked section answers; never stack several
  }

  if (secret.length > 0) {
    const groupLead = shown.length > 0 ? `${clip(shown[0]!).replace(/[.!]+$/, "")}. ` : "";
    return {
      kind: "private",
      groupText: answerText(firstName, `${groupLead}${PRIVATE_FACT_NOTE}`),
      privateText: toGsm7(clip(secret[0]!)),
    };
  }
  if (shown.length > 0) return { kind: "group", text: answerText(firstName, clip(shown[0]!)) };
  return { kind: "unknown" };
}
