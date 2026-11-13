import { leadSiteOfAddress } from "./common";
import { parseCraigslistLead } from "./craigslist";
import { parseFacebookLead } from "./facebook";
import { parseGenericLead } from "./generic";
import { parseRoomiesLead } from "./roomies";
import { parseRoomsterLead } from "./roomster";
import { parseSpareRoomLead } from "./spareroom-lead";
import { parseZillowLead } from "./zillow";
import { PLATFORM_LEAD_PARSER_VERIFIED, type LeadParseInput, type PlatformLeadMessage, type PlatformLeadSite } from "./types";

export * from "./types";
export { leadSiteOfAddress, isLeadRelayAddress, phoneInText } from "./common";
export { parseGenericLead } from "./generic";

const SITE_PARSERS: Record<PlatformLeadSite, (input: LeadParseInput) => PlatformLeadMessage | null> = {
  spareroom: parseSpareRoomLead,
  roomies: parseRoomiesLead,
  zillow: parseZillowLead,
  craigslist: parseCraigslistLead,
  facebook: parseFacebookLead,
  roomster: parseRoomsterLead,
};

/** `PLATFORM_LEAD_PARSERS=roomies,zillow`: the unverified sites whose own parser the captain has switched on. */
export function enabledUnverifiedParsers(env: string | undefined = process.env.PLATFORM_LEAD_PARSERS): ReadonlySet<PlatformLeadSite> {
  const wanted = new Set((env ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
  return new Set((Object.keys(SITE_PARSERS) as PlatformLeadSite[]).filter((site) => wanted.has(site)));
}

/**
 * Read one lead mail. The sender's domain decides the site (never the body). A verified or switched-on site's own parser
 * goes first; when it is off, unverified, or reads nothing, the generic fallback reads it, so nothing is dropped.
 * Null = the sender is not a lead site, or the mail has no readable message.
 */
export function parsePlatformLead(
  input: LeadParseInput,
  options: { enabled?: ReadonlySet<PlatformLeadSite> } = {},
): PlatformLeadMessage | null {
  const site = leadSiteOfAddress(input.fromEmail);
  if (!site) return null;
  const enabled = options.enabled ?? enabledUnverifiedParsers();
  if (PLATFORM_LEAD_PARSER_VERIFIED[site] || enabled.has(site)) {
    const own = SITE_PARSERS[site](input);
    if (own) return own;
  }
  return parseGenericLead(site, input);
}
