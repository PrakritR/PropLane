/**
 * Does an inbound message ASK for something the manager would otherwise have to
 * file by hand? (PRP-109)
 *
 * This is the one decision behind every message-derived workflow: the manager
 * inbox chips, and the server pass that turns a text or an email into a
 * proposed work order. Deliberately PURE and deterministic — no model, no I/O,
 * no network — for three reasons:
 *
 * 1. It runs on EVERY inbound message across three channels. A model call per
 *    message is a cost and a latency the webhook path cannot absorb.
 * 2. Resident and prospect text is untrusted input. A regex cannot be
 *    prompt-injected; a classifier prompt can.
 * 3. It is table-testable, so tuning it is editing a list and reading a diff
 *    rather than eyeballing generations.
 *
 * Nothing here ever writes. The output only ever seeds a PROPOSAL that a human
 * confirms, which is why a false positive costs an ignorable chip rather than a
 * wrong work order. That asymmetry is what lets the patterns stay generous.
 *
 * If this is ever swapped for a model, keep this signature and put the model
 * behind it — the callers must not learn which it is.
 */

export type InboundMessageIntent = "maintenance" | "add_on_service" | "none";

export type InboundMessageIntentResult = {
  intent: InboundMessageIntent;
  /** 0..1. Below `INTENT_MIN_CONFIDENCE` the caller should stay silent. */
  confidence: number;
  /** Which patterns fired. Exported so a bad suggestion can be explained. */
  signals: string[];
  /** Maintenance only: an emergency should jump the queue. */
  urgency: "emergency" | "normal" | null;
};

/** Below this, a match is too weak to put in front of a manager. */
export const INTENT_MIN_CONFIDENCE = 0.5;

/**
 * Strong maintenance nouns — a thing that is broken, named directly. One of
 * these alone is enough, because nobody mentions a burst pipe in passing.
 */
const MAINTENANCE_STRONG = [
  /\bleak(s|ing|ed)?\b/i,
  /\bburst pipe\b/i,
  /\bwater damage\b/i,
  /\bflood(ing|ed)?\b/i,
  /\bmold\b/i,
  /\bno (hot )?water\b/i,
  /\bno heat\b/i,
  /\bgas smell\b/i,
  /\bsmell(s|ing)? (of |like )?gas\b/i,
  /\bsmoke detector\b/i,
  /\bclogged\b/i,
  /\bbacked up\b/i,
  /\bnot working\b/i,
  /\bstopped working\b/i,
  /\bwon'?t (turn on|start|open|close|lock|flush|drain)\b/i,
  /\bmaintenance request\b/i,
  /\bwork order\b/i,
];

/**
 * Failure words — something is wrong. On their own these are ambiguous ("fix a
 * time", "repair the wording"), which is why they only count alongside a
 * fixture below.
 */
const MAINTENANCE_FAILURE = [
  /\bbroke(n)?\b/i,
  /\brepair(s|ing)?\b/i,
  /\bfix\b/i,
  /\bout of order\b/i,
  /\bdoes ?n'?t work\b/i,
  /\bwon'?t work\b/i,
  /\bdamaged?\b/i,
  /\bcracked\b/i,
  /\bjammed\b/i,
  /\bstuck\b/i,
  /\bdead\b/i,
  /\bmaintenance\b/i,
];

/**
 * Fixtures — the things in a home that break. A noun alone is a topic, not a
 * report, so these only count alongside a failure word or a strong phrase.
 */
const MAINTENANCE_FIXTURE = [
  /\btoilet\b/i,
  /\bsink\b/i,
  /\bfaucet\b/i,
  /\bshower\b/i,
  /\bbath ?tub\b/i,
  /\bpipe\b/i,
  /\bdrain\b/i,
  /\bplumb(ing|er)\b/i,
  /\boutlet\b/i,
  /\belectric(al)?\b/i,
  /\bwiring\b/i,
  /\bbreaker\b/i,
  /\bheat(er|ing)?\b/i,
  /\bhvac\b/i,
  /\bfurnace\b/i,
  /\bthermostat\b/i,
  /\bair conditioning\b/i,
  /\bair conditioner\b/i,
  /\ba\/?c\b/i,
  /\bfridge\b/i,
  /\brefrigerator\b/i,
  /\bdishwasher\b/i,
  /\bwasher\b/i,
  /\bdryer\b/i,
  /\bstove\b/i,
  /\boven\b/i,
  /\bmicrowave\b/i,
  /\bdisposal\b/i,
  /\bappliance\b/i,
  /\block(s|ed|ing)?\b/i,
  /\bdoor\b/i,
  /\bwindow\b/i,
  /\bceiling\b/i,
  /\bfloor(ing)?\b/i,
  /\bwall\b/i,
  /\blight(s|ing)?\b/i,
  /\bfan\b/i,
  /\bgate\b/i,
  /\bpest(s)?\b/i,
  /\broach(es)?\b/i,
  /\bmice\b/i,
  /\bants\b/i,
];

/** Add-on offerings a resident buys — parking, storage, amenities. */
const ADDON_STRONG = [
  /\bparking (spot|space|spaces|stall)\b/i,
  /\bstorage (unit|space|locker)\b/i,
  /\bgarage (spot|space)\b/i,
  /\breserved spot\b/i,
  /\bextra key\b/i,
  /\badd[- ]?on\b/i,
];

const ADDON_WEAK = [
  /\bparking\b/i,
  /\bstorage\b/i,
  /\bamenity\b/i,
  /\bamenities\b/i,
  /\bpet fee\b/i,
  /\bbike (rack|storage)\b/i,
  /\blocker\b/i,
];

/**
 * The message is ASKING, not just mentioning. A request reads as a request:
 * "can I", "could you", "please", "I need", "is it possible".
 */
const REQUEST_MARKERS = [
  /\b(can|could|would) (i|you|we)\b/i,
  /\bplease\b/i,
  /\bi need\b/i,
  /\bi'?d like\b/i,
  /\bi would like\b/i,
  /\bis it possible\b/i,
  /\bhow do i\b/i,
  /\bcan we get\b/i,
  /\bneeds? (to be|fixing|repair)/i,
  /\bsend someone\b/i,
  /\bcome (out|by|and) (look|fix|check)/i,
];

/**
 * The thing is already handled, or is being discussed rather than reported.
 * This is the single largest source of false positives: a thread ABOUT a leak
 * keeps saying "leak" long after the plumber has been.
 */
const RESOLVED_MARKERS = [
  /\b(is|was|has been|have been|all|already|now) (been )?(fixed|repaired|resolved|sorted|done|taken care of)\b/i,
  /\bthanks? (for|so much for) (fixing|repairing|sorting|handling|taking care)/i,
  /\bno (longer|more) (an? )?(issue|problem|leak)\b/i,
  /\bnever ?mind\b/i,
  /\bworking (fine|now|again)\b/i,
  /\bworks (fine|now|again)\b/i,
  /\ball good\b/i,
  /\bdisregard\b/i,
];

/** Emergencies a manager must see first. */
const EMERGENCY_MARKERS = [
  /\bemergency\b/i,
  /\burgent\b/i,
  /\bflood(ing|ed)?\b/i,
  /\bburst pipe\b/i,
  /\bgas smell\b/i,
  /\bsmell(s|ing)? (of |like )?gas\b/i,
  /\bfire\b/i,
  /\bno heat\b/i,
  /\bno (hot )?water\b/i,
  /\bsewage\b/i,
  /\bcarbon monoxide\b/i,
];

function matched(text: string, patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) hits.push(m[0].toLowerCase());
  }
  return hits;
}

/**
 * Classify one inbound message.
 *
 * Eligibility first, then scoring. A plain score let one ambiguous word plus a
 * polite opener ("Can we fix a time to meet?") clear the bar, so what qualifies
 * is structural:
 * - MAINTENANCE: a self-sufficient phrase ("no hot water", "not working",
 *   "leaking"), OR a failure word naming a fixture ("toilet ... broken").
 *   Neither half counts alone — "fix a time" names no fixture, "the sink" names
 *   no failure.
 * - ADD-ON: a named offering ("parking spot", "storage unit"), OR a topic word
 *   plus someone actually asking. "Parking is tight round here" is a remark.
 * - A request marker adds 0.25 wherever it appears, but never creates
 *   eligibility on its own.
 * - Anything reading as already-resolved returns `none` outright, first, before
 *   any of the above.
 */
export function classifyInboundMessage(messageText: string): InboundMessageIntentResult {
  const text = String(messageText ?? "").trim();
  const none: InboundMessageIntentResult = {
    intent: "none",
    confidence: 0,
    signals: [],
    urgency: null,
  };
  if (!text) return none;

  // "The leak is fixed, thanks" must never propose a work order. Checked first
  // and unconditionally: a resolved message is not a request no matter how many
  // subject words it contains.
  const resolved = matched(text, RESOLVED_MARKERS);
  if (resolved.length > 0) return { ...none, signals: resolved.map((s) => `resolved:${s}`) };

  const requestHits = matched(text, REQUEST_MARKERS);
  const requestBonus = requestHits.length > 0 ? 0.25 : 0;

  // Maintenance: a self-sufficient phrase, OR a failure word naming a fixture.
  // "My toilet is broken" is a report even though nobody said please; "can we
  // fix a time to meet" names no fixture and is not.
  const mStrong = matched(text, MAINTENANCE_STRONG);
  const mFailure = matched(text, MAINTENANCE_FAILURE);
  const mFixture = matched(text, MAINTENANCE_FIXTURE);
  const maintenance = {
    eligible: mStrong.length > 0 || (mFailure.length > 0 && mFixture.length > 0),
    score: Math.min(0.6 + requestBonus, 1),
    signals: [
      ...mStrong.map((s) => `strong:${s}`),
      ...mFailure.map((s) => `failure:${s}`),
      ...mFixture.map((s) => `fixture:${s}`),
    ],
  };

  // Add-ons: a named offering, or a topic word plus someone actually asking.
  // "Parking is tight round here" is a remark, not an order.
  const aStrong = matched(text, ADDON_STRONG);
  const aWeak = matched(text, ADDON_WEAK);
  const addon = {
    eligible: aStrong.length > 0 || (aWeak.length > 0 && requestBonus > 0),
    score: Math.min((aStrong.length > 0 ? 0.6 : 0.5) + requestBonus, 1),
    signals: [...aStrong.map((s) => `strong:${s}`), ...aWeak.map((s) => `weak:${s}`)],
  };

  if (!maintenance.eligible && !addon.eligible) {
    return { ...none, signals: [...maintenance.signals, ...addon.signals] };
  }

  // A message can touch both ("the garage spot light is out"). Only an ELIGIBLE
  // side can win — score alone would hand every add-on ask to maintenance,
  // whose score is computed whether or not it qualified. Maintenance wins a
  // genuine tie: an unreported broken thing costs more than an unbooked spot.
  const pickMaintenance = maintenance.eligible && (!addon.eligible || maintenance.score >= addon.score);
  const winner = pickMaintenance ? maintenance : addon;
  const intent: InboundMessageIntent = pickMaintenance ? "maintenance" : "add_on_service";

  if (winner.score < INTENT_MIN_CONFIDENCE) {
    return { intent: "none", confidence: winner.score, signals: winner.signals, urgency: null };
  }

  const emergencyHits = intent === "maintenance" ? matched(text, EMERGENCY_MARKERS) : [];
  return {
    intent,
    confidence: winner.score,
    signals: [
      ...winner.signals,
      ...requestHits.map((s) => `request:${s}`),
      ...emergencyHits.map((s) => `emergency:${s}`),
    ],
    urgency: intent === "maintenance" ? (emergencyHits.length > 0 ? "emergency" : "normal") : null,
  };
}

/** Short title for a work order seeded from a message. */
export function workflowTitleFromMessage(messageText: string, fallback: string): string {
  const line = String(messageText ?? "").trim().split(/\n/)[0]?.trim() ?? "";
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
