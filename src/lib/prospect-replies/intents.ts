import type { ProspectIntentId, ProspectLinkKind, ProspectReplyFacts } from "@/lib/prospect-replies/types";

/**
 * The canned-intent registry: every common prospect question in one table.
 *
 * To add an intent, add ONE row here. That single row feeds all four consumers, so they cannot drift apart:
 *   - `classifyProspectIntents` (what is the prospect asking),
 *   - `composeProspectReply` (the deterministic reply built from listing facts, used when the model is unavailable),
 *   - `ensureProspectReplyLinks` (the guard that appends a link the model forgot),
 *   - `prospectIntentPlaybook` (the paragraph appended to the leasing agent's system prompt).
 *
 * `answer` reads ONLY the facts it is given and returns null when the fact is unknown; it never calculates a total, never
 * rounds, never turns an unknown into a yes or a no. `links` are the pages that make the answer actionable.
 */
export type ProspectIntentDef = {
  id: ProspectIntentId;
  /** What the prospect asked about, in the words of "I'll confirm <topic> with the manager". */
  topic: string;
  /** Any pattern matching the lowercased message selects the intent. */
  patterns: RegExp[];
  /** Pages that answer this request, most useful first. */
  links: ProspectLinkKind[];
  /** Instruction line for the system prompt playbook. */
  hint: string;
  /**
   * One short grounded sentence from the facts, "" when the link itself is the answer (tour, apply, photos), or null
   * when the listing does not say (the reply then points at the listing page instead of guessing).
   */
  answer: (facts: ProspectReplyFacts) => string | null;
  /** Label printed before the link when this intent chose it (falls back to the kind's default label). */
  linkLabel?: Partial<Record<ProspectLinkKind, string>>;
};

const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

function homeName(facts: ProspectReplyFacts): string {
  return facts.title?.trim() || "this home";
}

function pricedRooms(facts: ProspectReplyFacts) {
  return facts.rooms.filter((room) => typeof room.monthlyRent === "number" && room.monthlyRent > 0);
}

function rentRange(facts: ProspectReplyFacts): string | null {
  const rents = pricedRooms(facts).map((room) => room.monthlyRent as number);
  if (rents.length === 0) return null;
  const low = Math.min(...rents);
  const high = Math.max(...rents);
  return low === high ? `${money(low)}/mo` : `${money(low)} to ${money(high)}/mo`;
}

export const PROSPECT_INTENTS: readonly ProspectIntentDef[] = [
  {
    id: "tour",
    topic: "the tour",
    patterns: [
      /\btours?\b/,
      /\b(visit|viewing|view the|come (by|see|look)|walk[- ]?through|showing|see (it|the (place|room|house|home))( in person)?|in person|stop by|swing by)\b/,
    ],
    links: ["tour"],
    hint: "tour, visit, see it in person: send tourUrl and say they pick the time there.",
    answer: () => "",
  },
  {
    id: "apply",
    topic: "the application",
    patterns: [
      /\bapply\b/,
      /\bapplication\b/,
      /\b(how (do|can) i (rent|get started|sign up)|get started|sign up|requirements?|qualif(y|ications?)|income|credit (check|score)|background check|screening|co-?sign(er)?|guarantor)\b/,
      /\b(rent (it|the (room|place|house))|take (it|the room)|reserve|hold the room|i want (it|the room))\b/,
    ],
    links: ["apply"],
    hint: "apply, requirements, income or credit, how to rent, 'I'll take it': send applyUrl (the manager reviews applications there). Never collect application details by text.",
    answer: () => "",
  },
  {
    id: "application_fee",
    topic: "the application fee",
    patterns: [
      /\b(application|app|apply(ing)?)\b.{0,30}\b(fee|cost|charge|free|pay)\b/,
      /\b(fee|fees)\b.{0,30}\b(application|app|apply)\b/,
      /\bapplication fee\b/,
    ],
    links: ["apply"],
    hint: "application fee: quote applicationFee.amount from get_listing_details (applications are free unless the tool says otherwise) and send applyUrl. Unknown: say you will confirm.",
    answer: (facts) =>
      facts.applicationFee
        ? facts.applicationFee.free
          ? "The application is free."
          : `The application fee is ${facts.applicationFee.amount}.`
        : null,
  },
  {
    id: "availability",
    topic: "availability",
    patterns: [
      /\b(available|availability|vacan(t|cy|cies)|openings?|any (rooms?|room|spots?|units?) (open|left|free)|still (open|available|free)|is (it|the room|this) (open|free)|move[- ]?in|move in|when can i|earliest|start date|ready by)\b/,
    ],
    links: ["listing"],
    hint: "availability, move-in date: quote 'availableNowCount of roomCount rooms available now' from get_listing_details (never count rooms yourself); for exact dates call check_room_availability. Not verified: say you will confirm. Send listingUrl.",
    answer: (facts) =>
      facts.availableNowCount !== null && facts.roomCount !== null && facts.roomCount > 0
        ? `${facts.availableNowCount} of ${facts.roomCount} rooms at ${homeName(facts)} are available now.`
        : null,
    linkLabel: { listing: "Rooms and dates" },
  },
  {
    id: "price",
    topic: "the rent",
    patterns: [
      /\b(price|prices|pricing|rent|rents|rental rate|rate|rates|cost|costs|how much|per month|a month|monthly|\/mo|afford|budget|cheapest|cheap|expensive|what do (you|they) charge)\b/,
      /\$\s?\d/,
    ],
    links: ["listing"],
    hint: "price, rent, how much per room: quote each room's monthly rent from get_listing_details, never a total you worked out. Send listingUrl.",
    answer: (facts) => {
      const priced = pricedRooms(facts);
      if (priced.length === 0) return null;
      const range = rentRange(facts) as string;
      if (priced.length === 1) {
        const room = priced[0]!;
        return `${room.name} at ${homeName(facts)} is ${money(room.monthlyRent as number)}/mo${room.flexiblePrice ? ", and the manager can discuss that price" : ""}.`;
      }
      const flexible = priced.some((room) => room.flexiblePrice);
      return `Rooms at ${homeName(facts)} run ${range}${flexible ? " (some prices the manager can discuss)" : ""}.`;
    },
  },
  {
    id: "lease_length",
    topic: "lease terms",
    patterns: [
      /\b(lease|leases|leasing term|lease length|how long|minimum (stay|lease|term)|month[- ]to[- ]month|\d+[- ]?months?|6 mo|12 mo|a year|one year|yearly|term)\b/,
    ],
    links: ["listing"],
    hint: "lease length, terms, month-to-month: list leaseTerms from get_listing_details only. Send listingUrl.",
    answer: (facts) => {
      const terms = facts.leaseTerms.filter((term) => term.trim());
      return terms.length > 0 ? `Lease terms listed: ${terms.join(", ")}.` : null;
    },
  },
  {
    id: "deposit",
    topic: "the deposit",
    patterns: [/\b(deposit|deposits|security|first and last|last month|move[- ]in (cost|costs|fee|fees)|upfront)\b/],
    links: ["listing"],
    hint: "deposit, move-in costs: quote securityDeposit exactly as get_listing_details words it. Send listingUrl.",
    answer: (facts) => (facts.securityDeposit ? `The security deposit is ${facts.securityDeposit}.` : null),
  },
  {
    id: "utilities",
    topic: "utilities",
    patterns: [/\b(utilit(y|ies)|internet|wi-?fi|electric(ity)?|water|gas bill|heat|included|bills?)\b/],
    links: ["listing"],
    hint: "utilities, internet, what is included: quote the utilities fields from get_listing_details exactly; never say utilities are included unless the tool does. Send listingUrl.",
    answer: (facts) => (facts.utilities ? `Utilities: ${facts.utilities}.` : null),
  },
  {
    id: "pets",
    topic: "the pet policy",
    patterns: [/\b(pet|pets|dog|dogs|cat|cats|puppy|kitten|animal|animals|esa|emotional support|service animal)\b/],
    links: ["listing"],
    hint: "pets: use petFriendly from get_listing_details; null means unknown, say you will confirm. Never grant an exception or give ESA advice. Send listingUrl.",
    answer: (facts) =>
      facts.petFriendly === true
        ? "The listing says pets are welcome."
        : facts.petFriendly === false
          ? "The listing says no pets."
          : null,
  },
  {
    id: "couples",
    topic: "sharing a room",
    patterns: [
      /\b(couple|couples|partner|girlfriend|boyfriend|wife|husband|spouse|fianc[ee]e?|two of us|2 of us|both of us|me and my|share (a|the) room|sharing a room|room ?mate|move in together|bring (my|a) (friend|sister|brother|kid|child|baby))\b/,
    ],
    links: ["listing"],
    hint: "couples, partners, sharing a room: quote each room's published residentCapacity only; never infer one resident per bedroom and never promise approval. Send listingUrl.",
    answer: (facts) => {
      const multi = facts.rooms.filter((room) => (room.residentCapacity ?? 0) >= 2);
      if (multi.length > 0) {
        const names = multi.slice(0, 3).map((room) => room.name).join(", ");
        return `${names} ${multi.length === 1 ? "is" : "are"} listed for 2 or more residents.`;
      }
      const known = facts.rooms.filter((room) => room.residentCapacity !== null);
      if (known.length > 0 && known.length === facts.rooms.length) return "Each room is listed for 1 resident, so the manager decides on anyone sharing.";
      return null;
    },
  },
  {
    id: "furnished",
    topic: "furnishing",
    patterns: [/\b(furnish(ed|ing|ings)?|unfurnished|furniture|bed frame|mattress|desk|dresser|bring my own)\b/],
    links: ["listing"],
    hint: "furnished: use each room's furnishing from get_listing_details, not a home summary. Send listingUrl.",
    answer: (facts) => {
      const furnishings = [...new Set(facts.rooms.map((room) => room.furnishing?.trim()).filter((value): value is string => Boolean(value)))];
      if (furnishings.length === 0) return null;
      return furnishings.length === 1 ? `Furnishing: ${furnishings[0]}.` : `Furnishing varies by room: ${furnishings.slice(0, 3).join("; ")}.`;
    },
  },
  {
    id: "parking",
    topic: "parking",
    patterns: [/\b(park|parking|garage|driveway|carport|ev charg(er|ing)|bike (storage|room|rack)|bicycle|car\b|vehicle)\b/],
    links: ["listing"],
    hint: "parking, bikes: the listing page lists parking and amenities. Only state it when get_listing_details says so; otherwise send listingUrl and say you will confirm with the manager.",
    // The structured listing facts carry no parking field: the page is the source, so this is always a pointer.
    answer: () => null,
  },
  {
    id: "short_stay",
    topic: "short stays",
    patterns: [
      /\b(short[- ]?term|short stay|nightly|per night|by the night|few (weeks|nights|days)|airbnb|weekly|for a (week|weekend|month only)|(one|a|1|two|three|\d+) (nights?|weeks?)|temporary|temp housing|sublet|summer only|just for)\b/,
    ],
    links: ["stay"],
    hint: "short stay (nights or a few weeks, up to 28 nights): send the stay link and say they request it there with a PropLane account; the host confirms within 24 hours and nothing is charged before then. Use quote_short_stays on the PropLane line for exact options. Never quote a nightly total yourself.",
    answer: (facts) =>
      facts.shortStayOffered === true
        ? "Short stays are offered here, you request dates in the portal and the host confirms."
        : facts.shortStayOffered === false
          ? "The listing does not offer short stays."
          : null,
    linkLabel: { stay: "Request a short stay" },
  },
  {
    id: "location",
    topic: "the location",
    patterns: [
      /\b(where|location|located|neighbou?rhood|address|near|nearby|close to|walking distance|walk to|transit|bus|light ?rail|link station|commute|campus|university|uw\b|downtown|distance|area|street|grocery|groceries)\b/,
    ],
    links: ["listing"],
    hint: "location, transit, neighborhood: use the neighborhood and the tool's distances (get_nearby_transit, list_live_listings area); never turn distance into walking time. Send listingUrl.",
    answer: (facts) => (facts.neighborhood ? `${homeName(facts)} is in ${facts.neighborhood}.` : null),
  },
  {
    id: "house_rules",
    topic: "house rules",
    patterns: [/\b(quiet hours?|smok(e|ing|er)|non-?smok(ing|er)|noise|guests? (over|allowed)|visitors?|house rules?|rules|curfew|cleaning|chores?|bedding|linens?|sheets|duvet|laundry|kitchen|shared (kitchen|bath|bathroom|space)|bathroom)\b/],
    links: ["listing"],
    hint: "house rules, quiet hours, smoking, laundry, bedding, kitchen, bathroom: answer only what get_listing_details or the house info says, otherwise send listingUrl and say you will confirm with the manager.",
    answer: () => null,
  },
  {
    id: "check_in",
    topic: "arrival and check-in",
    patterns: [/\b(check[- ]?in|check[- ]?out|arrive|arriving|arrival|late (check|arrival)|early (check|arrival)|what time (can|do) i|key|keys|door code|lockbox|self check)\b/],
    links: ["listing"],
    hint: "arrival time, early or late check-in, keys: never quote codes or times from memory; send listingUrl and say the manager confirms arrival details. Never text a door code to a prospect.",
    answer: () => null,
  },
  {
    id: "cancellation",
    topic: "cancellation and refunds",
    patterns: [/\b(cancel|cancell?ation|refund|non-?refundable|money back|invoice|receipt|reimburse)\b/],
    links: ["listing"],
    hint: "cancellation, refunds, invoices: never promise a refund or an exception; send listingUrl and escalate_to_manager for the unanswered part.",
    answer: () => null,
  },
  {
    id: "photos",
    topic: "photos",
    patterns: [/\b(photos?|pictures?|pics?|images?|video|virtual|floor ?plans?|layout|what does it look like|see inside|more of the)\b/],
    links: ["listing"],
    hint: "photos, video, floor plan: the listing page has them. Send listingUrl.",
    answer: () => "",
  },
  {
    id: "browse",
    topic: "homes",
    patterns: [
      /\b(what (homes|houses|rooms|places|listings|do you have)|other (homes|houses|rooms|options|places|listings)|more (options|homes|houses|rooms)|any (other|more) (homes|houses|rooms|options)|all (your )?(homes|houses|listings)|show me (homes|houses|rooms|what)|looking for (a )?(room|place|home|house|apartment)|need (a )?(room|place))\b/,
    ],
    links: ["browse"],
    hint: "no home matched yet, or 'what else do you have': send the browse-all link.",
    answer: () => "",
    linkLabel: { browse: "See all homes" },
  },
  {
    id: "human",
    topic: "that",
    patterns: [/\b(human|real person|speak (to|with)|talk to|call me|manager|landlord|someone (call|text|reach))\b/],
    links: ["message"],
    hint: "wants a person or has a long special request: send messageUrl, or escalate_to_manager when a decision is needed.",
    answer: () => "",
    linkLabel: { message: "Message the manager" },
  },
];

const BY_ID = new Map(PROSPECT_INTENTS.map((def) => [def.id, def] as const));

export function prospectIntentDef(id: ProspectIntentId): ProspectIntentDef {
  return BY_ID.get(id) as ProspectIntentDef;
}

function normalize(message: string): string {
  return String(message ?? "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every intent the message touches, in registry order (the registry order is the answer priority). A wish to apply or to
 * tour beats a price question in the same text only by sitting earlier in the registry.
 */
export function classifyProspectIntents(message: string): ProspectIntentId[] {
  const text = normalize(message);
  if (!text) return [];
  let hits = PROSPECT_INTENTS.filter((def) => def.patterns.some((pattern) => pattern.test(text))).map((def) => def.id);
  // "does the deposit apply to a one night stay" says apply about the deposit, not about applying to rent.
  if (/\b(deposit|fee|rent|price|charge)s?\b.{0,20}\bappl(y|ies)\b|\bappl(y|ies)\b.{0,12}\bto (a|the|my) (stay|night|room|lease)\b/.test(text)) hits = hits.filter((id) => id !== "apply");
  // "application fee" is one question: it is not also "how do I apply" + "how much".
  if (hits.includes("application_fee")) return hits.filter((id) => id !== "price" && id !== "apply");
  // "how long is the lease" mentions neither a price nor a visit; "how much is the deposit" is the deposit.
  if (hits.includes("deposit")) return hits.filter((id) => id !== "price");
  return hits;
}

/** The playbook paragraph for the leasing agent's system prompt, generated from the registry. */
export function prospectIntentPlaybook(): string {
  const lines = PROSPECT_INTENTS.map((def) => `- ${def.hint}`);
  return [
    "First text from a prospect: most listing sites forbid links in the ad, so your first reply is where they get the home's pages. Identify the home from what they wrote (a street number such as 5259 or 4709, a street name, or the ad title), else the listing they are already known to be about; call build_prospect_links for it and send its listingUrl, tourUrl and applyUrl. If two or more homes fit (two houses share a street) or none is named, never guess: ask ONE short question naming the homes and send each home's own listingUrl from list_live_listings in the same text.",
    "Common prospect questions and what each one needs (every link is copied from a tool result, never typed from memory):",
    ...lines,
    "A home question with no link in the reply is incomplete: answer from the tool, then send the page that lets them act. Applications are free unless get_listing_details says otherwise. Keep SMS to two segments when you can: one short answer, then at most two links, each with a plain label.",
  ].join("\n");
}
