import { toGsm7 } from "@/lib/one-number/segments";
import { guestFirstName } from "@/lib/one-number/ops-alert-lines";

/**
 * The ONE daily text PropLane's own people get about PropLane-managed workspaces (pure: no database, no clock):
 * today's check-ins and check-outs per house, new leads from the last 24 hours (count, first names and house), and a
 * single count for the routine payment reminders that went out, in place of one Team line per resident. A person
 * hears only the workspaces and houses their own alerts cover, so the lines handed in are already theirs.
 * Lines are never cut mid-sentence: a long digest becomes a second text, and an empty one is no text at all.
 */
export type DigestLead = { firstName: string | null; house: string | null };

export const SERVICE_DIGEST_MAX_CHARS = 450;
const LEADS_SHOWN = 4;

export function leadsDigestLine(leads: readonly DigestLead[]): string {
  if (leads.length === 0) return "";
  const shown = leads.slice(0, LEADS_SHOWN).map((l) => {
    const name = l.firstName ? guestFirstName(l.firstName) : "Someone";
    return l.house ? `${name} (${l.house.trim()})` : name;
  });
  const more = leads.length - shown.length;
  return `New leads, last 24 hours: ${leads.length}. ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}.`;
}

export function remindersDigestLine(residents: number): string {
  if (residents <= 0) return "";
  return `Payment reminders sent: ${residents} resident${residents === 1 ? "" : "s"}.`;
}

export function composeServiceDigest(input: {
  houseLines: readonly string[];
  leads: readonly DigestLead[];
  remindersResidents?: number;
  maxChars?: number;
}): string[] {
  const max = input.maxChars ?? SERVICE_DIGEST_MAX_CHARS;
  const lines = [
    ...input.houseLines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean),
    leadsDigestLine(input.leads),
    remindersDigestLine(input.remindersResidents ?? 0),
  ].filter(Boolean);
  if (lines.length === 0) return [];
  const header = "PropLane today:";
  const parts: string[] = [];
  let current = header;
  for (const line of lines) {
    const safe = toGsm7(line);
    if (current !== header && `${current}\n${safe}`.length > max) {
      parts.push(current);
      current = `${header} (cont.)`;
    }
    current = `${current}\n${safe}`;
  }
  parts.push(current);
  return parts;
}
