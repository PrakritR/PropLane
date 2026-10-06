/**
 * What the assistant tells a prospect from the AI info tab, by stay.
 *
 * Every AI info row is shared by default. A row may carry a short-term version
 * (`aiCommunicationInfoShortTerm`); a custom row may be for one stay (`appliesTo`, absent = both).
 *
 * - short-term prospect: the short-term text when the row has one, else the shared text;
 * - long-term prospect: the shared text ONLY - short-term text is never mixed in;
 * - stay unknown: the shared text and the short-term text, each clearly labelled.
 *
 * Pure: reads only the stored submission fields it is handed.
 */
import {
  AI_COMMUNICATION_INFO_SHORT_TERM_KEYS,
  normalizeAiCommunicationCustom,
  normalizeAiCommunicationInfo,
  normalizeAiCommunicationInfoShortTerm,
  type AiCommunicationCustomGroup,
  type AiCommunicationInfoShortTerm,
  type AiCommunicationInfoShortTermKey,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { inStay, stayLabel, type PropertyStay } from "@/lib/property-stay-tabs";

/** The prospect's stay, or null when nothing says which one they want. */
export type ProspectStay = PropertyStay | null;

type AiInfoSource = Partial<
  Pick<
    ManagerListingSubmissionV1,
    "marketingNotes" | "aiCommunicationInfo" | "aiCommunicationInfoShortTerm" | "aiCommunicationCustom"
  >
>;

/** One row's text for a prospect of `stay`, labelled when the stay is unknown and the two versions differ. */
export function aiInfoTextForStay(shared: string, shortTerm: string, stay: ProspectStay): string {
  const base = shared.trim();
  const short = shortTerm.trim();
  if (!short) return base;
  if (stay === "short_term") return short;
  if (stay === "long_term") return base;
  return [base ? `Shared: ${base}` : "", `Short term: ${short}`].filter(Boolean).join("\n");
}

export type AiInfoForStay = {
  /** Built-in rows (About this home included) with text for this prospect; empty rows are left out. */
  sections: Partial<Record<AiCommunicationInfoShortTermKey, string>>;
  custom: { id: string; title: string; group: AiCommunicationCustomGroup; text: string }[];
};

export function aiInfoForStay(source: AiInfoSource | null | undefined, stay: ProspectStay): AiInfoForStay {
  const shared = normalizeAiCommunicationInfo(source?.aiCommunicationInfo);
  const short = normalizeAiCommunicationInfoShortTerm(source?.aiCommunicationInfoShortTerm);
  const sections: AiInfoForStay["sections"] = {};
  for (const key of AI_COMMUNICATION_INFO_SHORT_TERM_KEYS) {
    const base = key === "about" ? (source?.marketingNotes ?? "") : (shared?.[key] ?? "");
    const text = aiInfoTextForStay(base, short?.[key] ?? "", stay);
    if (text) sections[key] = text;
  }
  const custom: AiInfoForStay["custom"] = [];
  for (const item of normalizeAiCommunicationCustom(source?.aiCommunicationCustom) ?? []) {
    const text = item.text.trim();
    if (!text) continue;
    if (stay) {
      if (!inStay(item.appliesTo, stay)) continue;
      custom.push({ id: item.id, title: item.title, group: item.group, text });
      continue;
    }
    // Unknown stay: a row for one stay says so, so it is never read as true of both.
    const only = item.appliesTo === "long_term" || item.appliesTo === "short_term" ? item.appliesTo : null;
    custom.push({ id: item.id, title: item.title, group: item.group, text: only ? `${stayLabel(only)}: ${text}` : text });
  }
  return { sections, custom };
}

/** The short-term texts with one row set (or, for blank text, removed); an empty map reads as absent. */
export function withShortTermText(
  current: AiCommunicationInfoShortTerm | undefined,
  key: AiCommunicationInfoShortTermKey,
  text: string,
): AiCommunicationInfoShortTerm | undefined {
  const next: AiCommunicationInfoShortTerm = { ...(current ?? {}) };
  const value = text.trim();
  if (value) next[key] = value;
  else delete next[key];
  return Object.keys(next).length ? next : undefined;
}
