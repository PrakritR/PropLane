import { buildManagerTourUrl } from "@/lib/manager-property-links";
import { stayRequestHref } from "@/lib/short-stay/stay-request-link";
import type { PickableHome } from "@/lib/prospect-replies/home-pick";
import type { ProspectLinks, ProspectReplyFacts, ProspectRoomFact } from "@/lib/prospect-replies/types";

type Json = Record<string, unknown>;
type Evidence = { tool: string; input?: unknown; output: unknown };

const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function latest(evidence: readonly Evidence[], tool: string): Json | null {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    if (evidence[i]!.tool !== tool) continue;
    const output = obj(evidence[i]!.output);
    if (output && output.ok !== false) return output;
  }
  return null;
}

function roomFacts(raw: unknown): ProspectRoomFact[] {
  if (!Array.isArray(raw)) return [];
  const out: ProspectRoomFact[] = [];
  for (const entry of raw) {
    const room = obj(entry);
    const name = text(room?.name);
    if (!room || !name) continue;
    const rent = num(room.monthlyRent);
    out.push({
      name,
      // A daily-priced room has no monthly price: it is left out of rent answers rather than converted.
      monthlyRent: room.rentBasis === "daily" ? null : rent !== null && rent > 0 ? rent : null,
      flexiblePrice: room.pricingMode === "flexible",
      furnishing: text(room.furnishing) || null,
      residentCapacity: num(room.residentCapacity),
      freeNow: typeof room.freeNow === "boolean" ? room.freeNow : null,
      freeFrom: typeof room.freeFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(room.freeFrom) ? room.freeFrom : null,
    });
  }
  return out;
}

const PAYMENT_MODEL_WORDS: Record<string, string> = {
  manager_billed: "billed with rent",
  variable: "billed by usage",
  tenant_direct: "paid directly by the resident",
  included_in_rent: "included in rent",
};

/** Utilities as one plain fragment, only from fields the listing carries; null when it says nothing. */
function utilitiesFragment(raw: unknown): string | null {
  const utilities = obj(raw);
  if (!utilities) return null;
  const rooms = (Array.isArray(utilities.rooms) ? utilities.rooms : []).map(obj).filter((room): room is Json => Boolean(room));
  const models = [...new Set(rooms.map((room) => text(room.paymentModel)).filter(Boolean))];
  const estimates = [...new Set(rooms.map((room) => text(room.estimate)).filter(Boolean))];
  const model = models.length === 1 ? PAYMENT_MODEL_WORDS[models[0]!] ?? null : null;
  const estimate = estimates.length === 1 ? estimates[0]! : null;
  if (model === "included in rent") return "included in rent";
  if (estimate || model) return [estimate ? `about ${estimate.replace(/^about\s+/i, "")}` : "", model ?? ""].filter(Boolean).join(", ");
  return text(utilities.costNotes).slice(0, 120) || null;
}

function depositLabel(raw: unknown): string | null {
  const deposit = obj(raw);
  if (!deposit) return null;
  const rooms = (Array.isArray(deposit.rooms) ? deposit.rooms : []).map(obj).filter((room): room is Json => Boolean(room));
  const effective = [...new Set(rooms.map((room) => text(room.standardLeaseEffectiveAmount)).filter(Boolean))];
  // Rooms that disagree have no single answer: the page lists each, so none is quoted here.
  if (effective.length > 1) return null;
  return effective[0] ?? (text(deposit.listingAmount) || null);
}

/**
 * Facts and links for the reply layer, read ONLY from this turn's tool results (`get_listing_details`,
 * `build_prospect_links`, `list_live_listings`, `get_site_links`). Returns what the tools returned and nothing else.
 */
export function prospectContextFromEvidence(evidence: readonly Evidence[], origin: string): { facts: ProspectReplyFacts | null; links: ProspectLinks } {
  const base = origin.replace(/\/$/, "");
  const links: ProspectLinks = {};
  const built = latest(evidence, "build_prospect_links");
  if (built) {
    if (text(built.listingUrl)) links.listing = text(built.listingUrl);
    if (text(built.tourUrl)) links.tour = text(built.tourUrl);
    if (text(built.applyUrl)) links.apply = text(built.applyUrl);
    if (text(built.messageUrl)) links.message = text(built.messageUrl);
    if (text(built.browseUrl)) links.browse = text(built.browseUrl);
    const propertyId = text(built.propertyId);
    if (propertyId) links.stay = `${base}${stayRequestHref({ listing: propertyId })}`;
  }
  const listed = latest(evidence, "list_live_listings");
  if (listed) {
    if (!links.browse && text(listed.browseUrl)) links.browse = text(listed.browseUrl);
    const homes = Array.isArray(listed.listings) ? listed.listings.map(obj).filter((home): home is Json => Boolean(home)) : [];
    // Exactly one home in the answer is the home the conversation is about.
    if (!links.listing && homes.length === 1 && text(homes[0]!.listingUrl)) links.listing = text(homes[0]!.listingUrl);
  }
  const site = obj(latest(evidence, "get_site_links")?.links);
  if (site && !links.browse && text(site.browseHomes)) links.browse = text(site.browseHomes);
  if (!links.browse) links.browse = `${base}/rent/browse`;

  const details = obj(latest(evidence, "get_listing_details")?.listing);
  if (!details) return { facts: null, links };
  const leaseTerms = obj(details.leaseTerms);
  const terms = Array.isArray(leaseTerms?.available) ? leaseTerms.available.map(text).filter(Boolean) : [];
  const fee = obj(details.applicationFee);
  const facts: ProspectReplyFacts = {
    title: text(details.title) || null,
    neighborhood: text(details.neighborhood) || null,
    rooms: roomFacts(details.rooms),
    roomCount: num(details.roomCount),
    availableNowCount: num(details.availableNowCount),
    leaseTerms: terms.filter((term) => !/short-term|airbnb/i.test(term)),
    shortStayOffered: terms.length > 0 ? terms.some((term) => /short-term|airbnb/i.test(term)) : null,
    securityDeposit: depositLabel(details.securityDeposit),
    utilities: utilitiesFragment(details.utilities),
    petFriendly: typeof details.petFriendly === "boolean" ? details.petFriendly : null,
    applicationFee: fee && typeof fee.free === "boolean" && text(fee.amount) ? { free: fee.free, amount: text(fee.amount) } : null,
  };
  return { facts, links };
}

/**
 * Every home a `list_live_listings` result returned, each with its own page, tour page and CHECKED room availability, keyed by
 * the property id the tool returned. This is what the "what is available?" rundown reads: never a name, never a position.
 */
export function homesFromListEvidence(evidence: readonly Evidence[], origin: string): PickableHome[] {
  const listed = latest(evidence, "list_live_listings");
  const base = origin.replace(/\/$/, "");
  const homes = Array.isArray(listed?.listings) ? listed.listings.map(obj).filter((home): home is Json => Boolean(home)) : [];
  const out: PickableHome[] = [];
  for (const home of homes) {
    const propertyId = text(home.propertyId);
    const listing = text(home.listingUrl);
    if (!propertyId || !listing) continue;
    const rooms = roomFacts(home.rooms).map((room, i) => {
      const raw = obj((home.rooms as unknown[])[i]);
      // Only a room whose availability was CHECKED carries a date; an unchecked one carries nothing.
      return raw?.currentAvailabilityVerified === true ? room : { ...room, freeNow: null, freeFrom: null };
    });
    out.push({
      propertyId,
      title: text(home.address) || text(home.title) || "this home",
      links: { listing, tour: buildManagerTourUrl(base, propertyId), browse: text(listed?.browseUrl) || `${base}/rent/browse` },
      facts: {
        title: text(home.address) || text(home.title) || null,
        neighborhood: text(home.neighborhood) || null,
        rooms,
        roomCount: num(home.roomCount),
        availableNowCount: num(home.availableNowCount),
        leaseTerms: [],
        shortStayOffered: null,
        securityDeposit: null,
        utilities: null,
        petFriendly: typeof home.petFriendly === "boolean" ? home.petFriendly : null,
        applicationFee: null,
      },
    });
  }
  return out;
}
