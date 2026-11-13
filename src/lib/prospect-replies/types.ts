/**
 * Shapes for the prospect auto-reply layer. Pure data: nothing here reads a database or a clock.
 *
 * A reply is built from two inputs that BOTH come from tool results, never from the model's memory:
 *   - `ProspectReplyFacts`: what the listing says (rent, deposit, lease terms, pets, ...). A field that is `null` is
 *     UNKNOWN, and an unknown fact is never answered with a number or a yes/no.
 *   - `ProspectLinks`: the https pages a prospect can act on, minted by `build_prospect_links` / `get_site_links`.
 */

export type ProspectLinkKind = "listing" | "tour" | "apply" | "stay" | "browse" | "message";

export type ProspectLinks = Partial<Record<ProspectLinkKind, string>>;

export type ProspectRoomFact = {
  name: string;
  /** Monthly rent in whole dollars as the listing publishes it; null when the room has no monthly price. */
  monthlyRent: number | null;
  /** A flexible room's price is a starting point the manager can counter. */
  flexiblePrice: boolean;
  furnishing: string | null;
  /** Published resident capacity (not a legal occupancy limit, never derived from beds). */
  residentCapacity: number | null;
  /** Checked against the calendar this turn: true = free today. Null/absent = not verified, never assumed. */
  freeNow?: boolean | null;
  /** YYYY-MM-DD: the first day the room is free (today when free now). Null/absent = unknown. */
  freeFrom?: string | null;
};

export type ProspectReplyFacts = {
  title: string | null;
  neighborhood: string | null;
  rooms: ProspectRoomFact[];
  /** The listing page's own counts ("availableNowCount of roomCount"). Null availableNowCount = not verified. */
  roomCount: number | null;
  availableNowCount: number | null;
  /** Lease terms the listing allows, as published ("12-Month", "Month-to-Month"). */
  leaseTerms: string[];
  /** Does the listing take short stays at all? Null = unknown. */
  shortStayOffered: boolean | null;
  /** The standard-lease security deposit exactly as the listing words it ("$500"). */
  securityDeposit: string | null;
  /** Utilities as the listing words them, already a plain fragment ("about $90/mo, billed with rent"). */
  utilities: string | null;
  petFriendly: boolean | null;
  /** What applying costs, from the checkout's own resolver. Null = unknown. */
  applicationFee: { free: boolean; amount: string } | null;
};

export type ProspectIntentId =
  | "tour"
  | "apply"
  | "application_fee"
  | "availability"
  | "price"
  | "lease_length"
  | "deposit"
  | "utilities"
  | "pets"
  | "couples"
  | "furnished"
  | "parking"
  | "short_stay"
  | "location"
  | "photos"
  | "house_rules"
  | "check_in"
  | "cancellation"
  | "browse"
  | "human";

export type ProspectReply = {
  text: string;
  intents: ProspectIntentId[];
  /** The link kinds that ride the reply. */
  links: ProspectLinkKind[];
  /** Intents the facts could not answer: the reply points at the listing page instead of guessing. */
  unanswered: ProspectIntentId[];
};
