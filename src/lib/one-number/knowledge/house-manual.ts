/**
 * The house manual: the manager's free-text "house rules" and "general house info" on the listing. It is where the
 * fees and policies live (lockout fee, luggage storage, extension pricing, guests, ESA, deposit return), so a resident
 * asking about one is answered FROM it, never with "I don't have that". Pure.
 *
 * Only the passes of the manual that carry no secret go out: a line that quotes a door code, gate code or the Wi-Fi
 * password is dropped until the check-in reveal has opened (`includeHouseSecrets`), the same split `get_move_in_info`
 * makes. The staff-only Internal section is not part of the brief at all.
 */
import { containsHouseSecret, type HouseInfoV1 } from "@/lib/house-info";

export type HouseManualSection = { section: "House rules" | "General house info"; text: string };

export const HOUSE_MANUAL_MAX_CHARS = 6000;

export function houseManualForScope(
  scope: { includeHouseSecrets: boolean },
  brief: { houseInfo: HouseInfoV1; roomSecrets: readonly string[]; manual: { houseRulesText: string; generalHouseInfo: string } },
): HouseManualSection[] {
  const clean = (raw: string): string => {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const kept = scope.includeHouseSecrets ? lines : lines.filter((l) => !containsHouseSecret(l, brief.houseInfo, brief.roomSecrets));
    return kept.join("\n");
  };
  const out: HouseManualSection[] = [];
  let budget = HOUSE_MANUAL_MAX_CHARS;
  for (const [section, raw] of [
    ["House rules", brief.manual.houseRulesText],
    ["General house info", brief.manual.generalHouseInfo],
  ] as const) {
    const text = clean(raw).slice(0, Math.max(0, budget));
    if (!text) continue;
    budget -= text.length;
    out.push({ section, text });
  }
  return out;
}

/**
 * Words that make a fee/policy question a DISPUTE rather than a question: those still go to the team whatever the
 * manual says. A plain question about a written policy ("when is my deposit returned", "is a service animal allowed")
 * is answered from the manual.
 */
const DISPUTE_RE = /\b(dispute|chargeback|overcharg\w*|double charged|waive|waiver|reduce (?:my )?rent|rent reduction|payment plan|collections|owe me|lawyer|attorney|sue|legal|evict\w*|discriminat\w*)\b/i;

export function isDisputeText(text: string): boolean {
  return DISPUTE_RE.test(String(text ?? ""));
}
