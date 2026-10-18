/**
 * One-number knowledge: reply topics and the always-escalate screen. Pure.
 *
 * `REPLY_TOPICS` is the vocabulary of `sms_topic_reply_modes.topic` and of a
 * knowledge entry's `topic`. `classifyTopic` is a deliberately small keyword
 * classifier: it labels a question for filing and for the per-topic reply mode,
 * it never decides what the agent may say.
 */
import { ALWAYS_ESCALATE_TOPICS } from "../contracts";

export const REPLY_TOPICS = [
  "tour",
  "pricing",
  "availability",
  "house_rules",
  "amenities",
  "parking",
  "utilities",
  "maintenance",
  "payment",
  "application",
  "other",
] as const;

export type ReplyTopic = (typeof REPLY_TOPICS)[number];

export const REPLY_TOPIC_LABELS: Record<ReplyTopic, string> = {
  tour: "Tours",
  pricing: "Pricing",
  availability: "Availability",
  house_rules: "House rules",
  amenities: "Amenities",
  parking: "Parking",
  utilities: "Utilities",
  maintenance: "Maintenance",
  payment: "Payments",
  application: "Applications",
  other: "Other",
};

export function isReplyTopic(value: unknown): value is ReplyTopic {
  return typeof value === "string" && (REPLY_TOPICS as readonly string[]).includes(value);
}

/** Coerce anything stored (including the table default "general") to a known topic. */
export function normalizeTopic(value: unknown): ReplyTopic {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isReplyTopic(raw) ? raw : "other";
}

const TOPIC_PATTERNS: ReadonlyArray<readonly [ReplyTopic, RegExp]> = [
  ["tour", /\b(tour|tours|showing|viewing|walk[- ]?through|see the (?:house|room|place))\b/i],
  ["application", /\b(apply|application|applying|background check|credit check|co-?signer|screening)\b/i],
  ["parking", /\b(park|parking|garage|driveway|car|bike|bicycle|ev charg\w*)\b/i],
  ["utilities", /\b(utilit\w*|wi-?fi|internet|electric\w*|water bill|gas bill|trash|garbage|recycl\w*|laundry|heat|heating|a\/c|air conditioning)\b/i],
  ["maintenance", /\b(broken|leak\w*|repair|fix|maintenance|clog\w*|not working|stopped working|mold|pest|bugs?|mice|roaches)\b/i],
  ["payment", /\b(rent|pay|paid|payment|late fee|deposit|autopay|invoice|charge|balance)\b/i],
  ["pricing", /\b(price|pricing|cost|how much|per month|monthly|fees?|what does it cost)\b/i],
  ["availability", /\b(available|availability|vacan\w*|move[- ]?in date|open room|any rooms?|still open|lease length|how long)\b/i],
  ["house_rules", /\b(pets?|dog|cat|smok\w*|quiet hours|guests?|visitors?|rules?|policy|policies|curfew|party|parties)\b/i],
  ["amenities", /\b(amenit\w*|furnish\w*|kitchen|bathroom|bedroom|pool|gym|yard|patio|balcony|dishwasher|washer|dryer|storage)\b/i],
];

export function classifyTopic(text: string): ReplyTopic {
  const body = String(text ?? "");
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(body)) return topic;
  }
  return "other";
}

export type AlwaysEscalateTopic = (typeof ALWAYS_ESCALATE_TOPICS)[number];

const ESCALATE_PATTERNS: ReadonlyArray<readonly [AlwaysEscalateTopic, RegExp]> = [
  ["safety", /\b(gas leak|smells? (?:like )?gas|gas (?:smell|odou?r)|smell of gas|fire|smoke|flood\w*|burst pipe|carbon monoxide|break[- ]?in|assault|unsafe|threat\w*|weapon|gun|police|emergency)\b/i],
  ["fair_housing", /\b(discriminat\w*|race|religion|disabilit\w*|wheelchair|service animal|emotional support|familial status|national origin|pregnan\w*|children allowed|kids allowed|famil(?:y|ies) with|(?:with|have|has|allow\w*|no) (?:kids|children)|(?:kids|children) (?:allowed|ok|welcome)|what kind of people|demographic\w*|section 8|voucher|sexual orientation|gender)\b/i],
  ["legal", /\b(lawyer|attorney|sue|suing|lawsuit|legal|evict\w*|eviction notice|court|tenant rights|habitability|notice to vacate|lease violation|small claims)\b/i],
  ["money", /\b(refund|dispute|chargeback|overcharg\w*|double charged|owe|waive|waiver|reduce (?:my )?rent|rent reduction|payment plan|deposit back|security deposit return|collections)\b/i],
];

/** The first always-escalate topic the text touches, or null. Conservative on purpose. */
export function detectAlwaysEscalate(text: string): AlwaysEscalateTopic | null {
  const body = String(text ?? "");
  for (const [topic, pattern] of ESCALATE_PATTERNS) {
    if (pattern.test(body)) return topic;
  }
  return null;
}
