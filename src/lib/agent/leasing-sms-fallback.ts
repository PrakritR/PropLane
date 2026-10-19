/**
 * What a prospect is told when the model's reply cannot be shown (a link no lookup returned, an empty answer, a failed
 * catalog read). Pure: it reads only the tool results of the turn, so every home and link in it came from a tool. It never
 * contains the portal sentence "I can't verify that link", which is for a signed-in person, not for someone shopping for a room.
 */
import type { ToolEvidenceEntry } from "@/lib/agent/loop";

export const TEAM_FOLLOW_UP_REPLY = "Thanks for texting PropLane. I could not pull that up just now, so a teammate will follow up shortly.";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function latestOutput(evidence: ToolEvidenceEntry[], tool: string): Json | null {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    if (evidence[i].tool === tool) return obj(evidence[i].output);
  }
  return null;
}

function homeLine(raw: unknown): string | null {
  const home = obj(raw);
  const url = text(home?.listingUrl);
  if (!home || !url) return null;
  const name = text(home.title) || text(home.address);
  const where = text(home.neighborhood);
  const rent = typeof home.lowestRoomRent === "number" && home.lowestRoomRent > 0 ? `from $${Math.round(home.lowestRoomRent)}/mo` : text(home.rentLabel);
  const area = obj(home.areaMatch);
  const miles = typeof area?.distanceMiles === "number" ? `${area.distanceMiles} mi away` : "";
  const facts = [where, rent, miles].filter(Boolean).join(", ");
  return `${name}${facts ? ` (${facts})` : ""}: ${url}`;
}

/** The reply built from the turn's tool results alone. Always a short plain-text answer; never empty. */
export function summarizeLeasingEvidence(evidence: ToolEvidenceEntry[]): string {
  const list = latestOutput(evidence, "list_live_listings");
  if (list) {
    const homes = (Array.isArray(list.listings) ? list.listings : []).map(homeLine).filter((line): line is string => Boolean(line)).slice(0, 3);
    const area = obj(list.area);
    const browse = text(list.browseUrl);
    if (homes.length > 0) {
      const place = text(area?.place);
      const none = area?.resolved === true && area.nearCount === 0;
      const head = none
        ? `I do not see a home right at ${place || "that spot"}. The closest are`
        : place
          ? `Homes near ${place}:`
          : "Homes that fit:";
      return `${head} ${homes.join("; ")}.${browse ? ` See every home: ${browse}` : ""} Tell me which one you like.`;
    }
    if (browse) return `I do not have a home that fits that right now. You can see every home here: ${browse}`;
  }
  const links = latestOutput(evidence, "build_prospect_links");
  if (links && links.ok !== false && text(links.listingUrl)) {
    const title = text(links.title);
    return `Here is ${title ? `the listing for ${title}` : "the listing"}: ${text(links.listingUrl)}${text(links.tourUrl) ? ` Pick a tour time: ${text(links.tourUrl)}` : ""}${text(links.applyUrl) ? ` Apply: ${text(links.applyUrl)}` : ""}`;
  }
  const site = obj(latestOutput(evidence, "get_site_links")?.links);
  if (site && text(site.browseHomes)) return `${TEAM_FOLLOW_UP_REPLY} You can also see every home here: ${text(site.browseHomes)}`;
  return TEAM_FOLLOW_UP_REPLY;
}
