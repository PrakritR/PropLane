/**
 * What one text on the PropLane line is asking for, decided per message by rules (no model, no db).
 * The same person can ask about their houses in one text and look for a new place in the next, so
 * the answer is never remembered across messages: every text is classified on its own.
 *
 *   housing_search  "hey is there any house available", "looking for another place"
 *   pay_link        "send me my rent link", "how do I pay"
 *   write           an instruction to change something ("text Sam", "mark paid")
 *   status          a question about the houses they run (vacancies, unpaid rent, tours ...)
 *   other           anything else
 *
 * Pure so the rules can be tested directly and shared by the pipeline, the leasing bot and the
 * shared-line seam.
 */

export type LineIntentKind = "housing_search" | "pay_link" | "write" | "status" | "other";

export type StatusTopic = "overview" | "vacancies" | "rent" | "payments" | "tours" | "services" | "leases";

export type LineIntent = { kind: LineIntentKind; topic: StatusTopic };

const HOUSE_NOUN = "(?:house|houses|home|homes|room|rooms|place|places|apartment|apartments|apt|apts|unit|units|rental|rentals|listing|listings|housing|spot|spots|bedroom|bedrooms)";

/** "my house", "my rent", "our unit": the sender is talking about something they already have. */
const OWN_THING = /\b(my|our)\s+(?:\w+\s+)?(?:house|houses|home|homes|room|rooms|place|places|property|properties|unit|units|portfolio|tenants?|residents?|rent|lease|leases|rentals?)\b/;

/** Asking whether anything is free: a stranger's question, and also how a landlord asks about vacancies. */
const HOUSING_AVAILABILITY_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:any|is there|are there|do you (?:guys )?have|you (?:guys )?have|got any|have any)\\b.{0,50}\\b${HOUSE_NOUN}\\b`),
  new RegExp(`\\bwhat\\b.{0,20}\\b${HOUSE_NOUN}\\b.{0,25}\\b(?:do you have|you have|you got|are available|are open|is available|available)\\b`),
  /\b(?:anything|something)\b.{0,15}\b(?:available|open|for rent|to rent|vacant)\b/,
  new RegExp(`\\b${HOUSE_NOUN}\\b.{0,25}\\b(?:available|for rent|to rent|open now|up for grabs)\\b`),
];

/** Saying "I am looking": first person, unmistakable even from someone who runs houses. */
const HOUSING_PERSONAL_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:looking (?:for|to rent|to find|at)|searching for|hunting for|trying to find|want to rent|wanna rent|in the market for|seeking|interested in (?:renting|a|an|the))\\b.{0,30}\\b${HOUSE_NOUN}\\b`),
  /\blooking for somewhere\b/,
  new RegExp(`\\bneed (?:a|an|another) (?:new |different |cheap |cheaper |bigger |furnished |private |better )?${HOUSE_NOUN}\\b`),
  new RegExp(`\\bfind (?:me )?(?:a|an|another) (?:new |different )?${HOUSE_NOUN}\\b`),
  new RegExp(`\\b(?:another|a new|a different|other|new|different)\\s+${HOUSE_NOUN}\\b.{0,30}\\b(?:available|to rent|for rent|to move|looking)\\b`),
  /\b(?:move|moving|relocat\w*)\b.{0,25}\b(?:somewhere|elsewhere|another|new|different|out of state|to seattle|to the area)\b/,
];

/** Paying something they owe: a rent or charge link, how to pay. */
const PAY_PATTERNS: RegExp[] = [
  /\b(?:pay|paying|payment|pay link|payment link|checkout)\b/,
  /\b(?:rent|deposit|fee|charge|balance)\b.{0,20}\b(?:link|due|owe|owed|bill)\b/,
  /\b(?:link)\b.{0,20}\b(?:rent|deposit|fee|charge|balance)\b/,
  /\bhow much\b.{0,20}\b(?:owe|rent|due|balance)\b/,
  /\b(?:what do i owe|what i owe|my balance)\b/,
];

const WRITE_LEAD =
  /^(?:please\s+|pls\s+|plz\s+)?(?:(?:can|could|would) you\s+|i (?:want|need|would like) (?:you )?to\s+|go ahead and\s+)?(send|text|message|email|tell|remind|schedule|book|cancel|approve|decline|deny|mark|create|add|update|change|set|edit|delete|remove|dispatch|assign|charge|refund|waive|reply|respond|broadcast|announce|invite|draft|post|unlist|raise|lower|reschedule|extend|renew|terminate|evict)\b(.*)$/;

const READ_AFTER_LEAD = /^\s*(?:me|us)\b.*\b(?:status|summary|report|update|overview|numbers|rundown|list|everything|how)\b/;

const TOPIC_PATTERNS: Array<[StatusTopic, RegExp]> = [
  ["vacancies", /\b(?:vacan\w*|empty|open rooms?|available rooms?|rooms? (?:open|available|free)|which rooms?|any rooms?|openings?|unoccupied|occupancy|occupied)\b/],
  ["rent", /\b(?:unpaid|late|behind|overdue|outstanding|owe[sd]?|collected|collection|rent (?:status|roll|due)|hasn'?t paid|haven'?t paid|not paid)\b/],
  ["payments", /\b(?:payments?|paid|deposits?|payouts?|income|revenue|came in|received)\b/],
  ["tours", /\b(?:tours?|showings?|viewings?|touring)\b/],
  ["services", /\b(?:services?|repairs?|maintenance|work orders?|broken|fix(?:es|ed|ing)?|plumb\w*|leak\w*|issues?)\b/],
  ["leases", /\b(?:leases?|expir\w*|renewals?|renew|ending|ends|move[- ]?outs?|term)\b/],
  ["overview", /\b(?:status|how(?:'s| is| are| s)|summary|summarize|overview|update|report|rundown|doing|going|everything|portfolio|numbers)\b/],
];

const normalize = (body: string): string => body.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** A text looking for a place to live. A sender talking about their own home or rent is not. */
export function isHousingSearchText(body: string): boolean {
  const text = normalize(body);
  if (!text || text.length > 400) return false;
  if (OWN_THING.test(text)) return false;
  if (/\b(?:pay|paying|payment|owe|balance|late fee|due)\b/.test(text) && !/\b(?:available|looking|find)\b/.test(text)) return false;
  return HOUSING_AVAILABILITY_PATTERNS.some((pattern) => pattern.test(text)) || HOUSING_PERSONAL_PATTERNS.some((pattern) => pattern.test(text));
}

/** "I am looking for a place": the only housing search a person who runs houses means as one. */
export function isPersonalHousingSearchText(body: string): boolean {
  const text = normalize(body);
  if (!text || text.length > 400) return false;
  if (OWN_THING.test(text)) return false;
  return HOUSING_PERSONAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function isPayLinkText(body: string): boolean {
  const text = normalize(body);
  if (!text || text.length > 300) return false;
  if (isHousingSearchText(text)) return false;
  return PAY_PATTERNS.some((pattern) => pattern.test(text));
}

/** An instruction to change something, as opposed to a question. */
export function isWriteText(body: string): boolean {
  const text = normalize(body);
  const lead = WRITE_LEAD.exec(text);
  if (lead) {
    const rest = lead[2] ?? "";
    // "send me the status", "tell me how the houses are doing": a question in command form.
    if ((lead[1] === "send" || lead[1] === "text" || lead[1] === "tell" || lead[1] === "email") && READ_AFTER_LEAD.test(rest)) return false;
    return true;
  }
  return /\bmark\b.{0,30}\b(?:paid|rented|vacant|done|complete\w*)\b/.test(text);
}

export function statusTopicOf(body: string): StatusTopic {
  const text = normalize(body);
  for (const [topic, pattern] of TOPIC_PATTERNS) if (pattern.test(text)) return topic;
  return "overview";
}

/** Does the text carry any word of a status question at all (so "thanks" does not get a portfolio dump)? */
function mentionsStatus(body: string): boolean {
  const text = normalize(body);
  return TOPIC_PATTERNS.some(([, pattern]) => pattern.test(text));
}

/**
 * `member: true` is someone who runs houses on PropLane: "any rooms available" is their vacancy question, so only a
 * first-person search ("I'm looking for a place") counts as housing search for them.
 */
export function classifyLineText(body: string, options: { member?: boolean } = {}): LineIntent {
  const text = normalize(body);
  if (options.member ? isPersonalHousingSearchText(text) : isHousingSearchText(text)) return { kind: "housing_search", topic: "overview" };
  if (isWriteText(text)) return { kind: "write", topic: statusTopicOf(text) };
  if (isPayLinkText(text)) return { kind: "pay_link", topic: "payments" };
  if (mentionsStatus(text)) return { kind: "status", topic: statusTopicOf(text) };
  return { kind: "other", topic: "overview" };
}
