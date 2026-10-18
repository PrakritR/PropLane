/**
 * Cheap intent labels for the learning loop. A deterministic pass handles the
 * obvious texts for free; the Haiku classifier (intent.server.ts) only sees the
 * ones this cannot place. Log-only: nothing routes on the label except the
 * resident fast path, which requires `faq`.
 */

export const SMS_INTENTS = ["faq", "tour", "rent", "maintenance", "application", "human_needed", "other"] as const;
export type SmsIntent = (typeof SMS_INTENTS)[number];

const RULES: [SmsIntent, RegExp][] = [
  [
    "human_needed",
    /\b(real person|a human|talk to (a |the |my )?(person|human|manager|landlord|someone)|speak (to|with) (a |the )?(person|human|manager|landlord)|lawyer|attorney|sue\b|suing|evict|discriminat|harass|unsafe|emergency|gas leak|carbon monoxide|on fire|flood(ing|ed)?)\b|\bfire\b/i,
  ],
  [
    "maintenance",
    /\b(leak(s|ing)?|broken|broke|not working|stopped working|won'?t (work|turn|flush|open|start)|clog(ged)?|toilet|faucet|heater|no heat|no hot water|a\/?c\b|furnace|fridge|refrigerator|dishwasher|oven|stove|mold|mildew|roach(es)?|mice|mouse|rats?|bed ?bugs?|pest|locked out|lockout|repair|outlet|breaker|power (is )?out|wi-?fi (is )?(down|out|not)|internet (is )?(down|out|not)|ceiling|smoke alarm)\b/i,
  ],
  [
    "faq",
    /\b(wi-?fi|wifi|wireless|internet|network name|password|door code|gate code|front door|key ?code|lock ?box|parking|park (my|the|a) |trash|garbage|recycl\w*|compost|bins?|laundry|washer|dryer|quiet hours|guests?|overnight|smok\w*|pets?|dogs?|cats?|house rules?|emergency (number|contact)|after hours)\b/i,
  ],
  ["rent", /\b(rent|payment|pay(ing)?|late fee|balance|charges?|deposit|receipt|venmo|zelle|autopay|due date|owe)\b/i],
  ["tour", /\b(tour|viewing|visit|see the (house|room|place)|available|availability|vacan\w+|open room|schedule a|book a)\b/i],
  ["application", /\b(appl(y|ied|ication|icant)|background check|screening|credit check|lease (sign|renew)|sign (the|my) lease|documents?)\b/i],
];

/** The intent a text obviously carries, or null when the deterministic rules cannot tell. */
export function classifyIntentHeuristic(text: string): SmsIntent | null {
  const body = String(text ?? "");
  if (!body.trim()) return null;
  for (const [intent, pattern] of RULES) if (pattern.test(body)) return intent;
  return null;
}

export function coerceIntent(value: string | null | undefined): SmsIntent {
  const word = String(value ?? "").trim().toLowerCase().replace(/[^a-z_]/g, "");
  return (SMS_INTENTS as readonly string[]).includes(word) ? (word as SmsIntent) : "other";
}
