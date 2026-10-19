import { DEFAULT_OFFER_TIMEOUT_MINUTES, issueDefinition, type DispatchUrgency } from "@/lib/vendor-dispatch/trades";

/**
 * Maps a resident's service request onto the dispatch taxonomy (vendor-dispatch-1018):
 * which vendor role, which issue, how urgent. Pure. Returns null when the job should not
 * be dispatched by rule at all (a gas smell, fire or smoke goes to 911 and the team, never
 * to a vendor on the strength of a keyword).
 *
 * Also owns the per-issue triage questions the resident intake asks before dispatch, from
 * `docs/agents/vendor-dispatch-research.md` section 2, so the prompt and the engine read one list.
 */

export type DispatchInference = { trade: string; issue: string; urgency: DispatchUrgency };

export type TriageInput = {
  category?: string | null;
  title?: string | null;
  description?: string | null;
  priority?: string | null;
};

const DANGER = /\b(gas (?:smell|leak)|smell(?:s|ing)? gas|natural gas|carbon monoxide|co alarm|on fire|fire|burning|smoke|smoking|flames?)\b/i;

export function textIsDangerous(text: string): boolean {
  return DANGER.test(text);
}

function pickIssue(trade: string, text: string): string {
  const t = text.toLowerCase();
  switch (trade) {
    case "locksmith":
      if (/(locked out|lockout|can'?t get in|cannot get in|keys? (?:inside|locked)|lost (?:my )?key)/.test(t)) return "lockout";
      if (/re-?key/.test(t)) return "rekey";
      return "broken_lock";
    case "plumber":
      if (/(leak|flood|burst|overflow|water (?:everywhere|on the floor)|dripping ceiling)/.test(t)) return "leak";
      if (/(clog|backed up|backing up|drain|won'?t flush|slow)/.test(t)) return "clog";
      if (/(no hot water|cold (?:water )?only|water heater)/.test(t)) return "no_hot_water";
      return "fixture";
    case "electrician":
      if (/(spark|burning smell|hot outlet)/.test(t)) return "sparking";
      if (/(outage|power (?:is )?out|no power|breaker)/.test(t)) return "outage";
      return "fixture";
    case "hvac":
      return /(no (?:ac|a\/c|air)|air conditioner|not cooling|too hot)/.test(t) ? "no_cooling" : "no_heat";
    case "handyman":
      return /(smoke alarm|co alarm|detector|chirp|beeping)/.test(t) ? "alarm_chirp" : "repair";
    case "cleaner":
      return "deep_clean";
    case "appliance":
      return "broken_appliance";
    default:
      return "other";
  }
}

const CATEGORY_TRADE: Record<string, string> = {
  plumbing: "plumber",
  electrical: "electrician",
  hvac: "hvac",
  appliance: "appliance",
  access: "locksmith",
  cleaning: "cleaner",
  general: "handyman",
};

export function inferDispatchFromService(input: TriageInput): DispatchInference | null {
  const category = String(input.category ?? "").trim().toLowerCase();
  const text = `${input.title ?? ""} ${input.description ?? ""}`.trim();
  // A chirping alarm is a handyman job; an alarm that is ringing, or any smoke or gas, is not a vendor's to take.
  const chirpOnly = /\b(chirp|chirping|beeping|low battery)\b/i.test(text) && !/\b(smell|burning|ringing|going off|fire|flames?|gas)\b/i.test(text);
  if (textIsDangerous(text) && !chirpOnly) return null;
  let trade = CATEGORY_TRADE[category];
  // A "general" repair that is really a lock problem goes to the locksmith role.
  if ((!trade || trade === "handyman") && /(locked out|lockout|can'?t get in|deadbolt|rekey|re-key|lost (?:my )?key)/i.test(text)) trade = "locksmith";
  if (!trade) return null;
  const issue = pickIssue(trade, text);
  const base = issueDefinition(trade, issue)?.urgency ?? "routine";
  const priority = String(input.priority ?? "").trim();
  let urgency: DispatchUrgency = base;
  if (priority === "Emergency") urgency = "emergency";
  else if (priority === "High" && base === "routine") urgency = "urgent";
  return { trade, issue, urgency };
}

/** Offer timeout (minutes) when a rule sets none. */
export function defaultTimeoutMinutes(urgency: DispatchUrgency): number {
  return DEFAULT_OFFER_TIMEOUT_MINUTES[urgency];
}

/** The questions the resident intake asks before a job is dispatched (at most four, safety first). */
export const TRIAGE_QUESTIONS: Record<string, readonly string[]> = {
  lockout: [
    "Is anyone, a child or a pet, locked inside, or is something on like a stove? If yes, call 911.",
    "Which house and room are you locked out of?",
    "Is there a spare key or a lockbox code you can use?",
    "Text your name. We confirm you live there before anyone is sent.",
  ],
  leak: [
    "Is water near outlets or a light fixture? If yes, switch power off at the panel if it is safe.",
    "Can you close the shutoff valve under the sink or toilet, or the main?",
    "Is it clean water or sewage?",
    "Send a photo and say which floor.",
  ],
  no_heat: [
    "Is it the whole house, and what is the temperature inside?",
    "Is the thermostat set to heat and above the room temperature, with fresh batteries?",
    "Do you smell gas? If yes, leave, call 911 and the gas company.",
    "Send a photo of the breaker and the filter.",
  ],
  no_hot_water: [
    "Is it the whole house or one tap?",
    "Is the pilot lit or the breaker tripped?",
    "Is there any leak at the tank?",
  ],
  outage: [
    "Any burning smell, sparking or hot outlets? If yes, turn the panel off and tell us.",
    "One room or the whole house?",
    "Did you check the breaker?",
    "Are the neighbors out too?",
  ],
  clog: [
    "Is it overflowing right now?",
    "Is it the only toilet in the house?",
    "Have you tried a plunger?",
    "Is it backing up anywhere else?",
  ],
  pests: ["What kind of pest and where?", "For bed bugs, send a photo and how long.", "Is food storage involved?"],
  broken_appliance: ["What make and model?", "Is it safe to use, with no leak, smoke or smell?", "Send a photo."],
  alarm_chirp: [
    "Is it ringing now, or do you smell smoke or feel unwell? If yes, get out and call 911.",
    "Which unit is chirping?",
    "Is it a low-battery chirp?",
  ],
};

/**
 * Intake guidance for the resident SMS and portal assistants: 911 first, then at most a few
 * short questions, then the report. Kept compact because it rides every resident turn.
 */
export function triageGuidanceForPrompt(): string {
  const perIssue = Object.entries(TRIAGE_QUESTIONS)
    .map(([issue, questions]) => `${issue.replace(/_/g, " ")}: ${questions.slice(0, 3).join(" ")}`)
    .join(" | ");
  return [
    "Triage before a repair goes to a vendor. Safety first, then ask only what the resident's description leaves out. Put exactly ONE question in each text and wait for the answer before the next; never more than three or four in all; an emergency is filed at once while you ask. The resident's house and room are already on file from their lease: never ask which house or room, and never ask the same thing twice.",
    "A gas smell, smoke, fire or a carbon monoxide alarm: tell them to leave and call 911 and the gas company, and stop. Do not troubleshoot and never promise a vendor; the property team is alerted.",
    "Noise is a conduct issue for the property manager, never a vendor job. A lockout only gets a locksmith after the system matches the texter to a resident of that house; do not promise one. Never promise a price or an arrival time: the vendor confirms those.",
    `Questions by issue: ${perIssue}`,
  ].join(" ");
}
