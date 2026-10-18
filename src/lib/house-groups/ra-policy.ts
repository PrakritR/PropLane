import { classifySharedLineKeyword } from "@/lib/one-number/keywords";
import { inHouseQuietHours, nextPacificMorning } from "./time";

/**
 * The RA's manners, as pure functions. The RA is quiet by default: it speaks only when it is
 * addressed ("PropLane ..."), when a house-fact question has gone unanswered for about ten
 * minutes, when a complaint needs an acknowledgement, or in an emergency. No small talk, nothing
 * between 10 pm and 8 am except an emergency, and no more than N posts a day per house.
 */

/** How long a house-fact question may sit unanswered before the RA answers it. */
export const UNANSWERED_WAIT_MS = 10 * 60 * 1000;
/** Rule complaints inside this window count toward "repeated". */
export const RULE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RULE_REMINDER_AT = 2;
export const RULE_ESCALATE_AT = 3;

export type GroupFlag = "complaint" | "rule" | "safety" | "harassment" | "discrimination";

export type GroupTextClass = {
  /** The text names PropLane ("PropLane, what's the wifi?"). */
  addressed: boolean;
  emergency: boolean;
  /** A house-fact question (Wi-Fi, trash day, parking, laundry...). */
  houseQuestion: boolean;
  /** The strongest flag in the text, or null. */
  flag: GroupFlag | null;
  /** Rule topic when `flag` is `rule`. */
  ruleTopic: "noise" | "spaces" | "general" | null;
  /** "leave group" / "join group" typed into the group. */
  command: "leave" | "join" | null;
};

const ADDRESSED = /(?<![a-z0-9])@?prop\s?lane(?![a-z0-9])/i;
const LEAVE = /^\s*(please\s+)?(leave|exit|quit|remove me from)(\s+(the\s+)?(house\s+)?(group|thread|chat))\s*[.!]?\s*$/i;
const JOIN = /^\s*(please\s+)?(join|rejoin|add me to)(\s+(the\s+)?(house\s+)?(group|thread|chat))?\s*[.!]?\s*$/i;

const QUESTION_WORD = /^(what|what's|whats|when|where|who|which|how|is|are|does|do|can|could|anyone know|any idea|do you know)\b/i;
const HOUSE_TOPIC =
  /\b(wi-?fi|internet|router|password|trash|garbage|recycl\w*|compost|bins?|pick-?up|parking|park|laundry|washer|dryer|quiet hours|guests?|door code|code|lockbox|key|keys|gate|alarm|thermostat|heat|heater|utilities|mailbox|mail|package|packages|dishwasher|oven|trash day)\b/i;

const SAFETY_WORDS =
  /\b(unsafe|threat\w*|threaten\w*|stalk\w*|assault\w*|abus\w*|weapon|gun|knife|violen\w*|intimidat\w*|bully\w*)\b/i;
const HARASS_WORDS = /\b(harass\w*|hassl\w*|creep\w*|grop\w*|catcall\w*|follow(ing|ed) me)\b/i;
const DISCRIM_WORDS =
  /\b(racis\w*|racial\w*|discriminat\w*|go back to|sexis\w*|homophob\w*|transphob\w*|xenophob\w*|slur)\b/i;

const NOISE = /\b(loud|noise|noisy|music|party|partying|yelling|screaming|late at night|after midnight|2 ?am|3 ?am|stomp\w*)\b/i;
const SPACES =
  /\b(dishes|dirty|mess|messy|trash (is|was|left)|left (the )?(trash|garbage)|smell\w*|clean up|shared (space|kitchen|bathroom)|sink|fridge|stinks?)\b/i;
const GENERAL_RULE = /\b(smok\w*|vap\w*|overnight guests?|guest(s)? (staying|every)|parking (spot|violation)|my spot)\b/i;

const COMPLAINT =
  /\b(complain\w*|sick of|fed up|so annoying|annoying|rude|unacceptable|ridiculous|disgusting|can'?t stand|every (single )?(night|day)|again and again|keeps? (leaving|doing|playing)|always (leav\w*|loud|late)|never (clean\w*|wash\w*|take\w*)|not okay|not ok|enough already)\b/i;

export function classifyGroupText(text: string): GroupTextClass {
  const body = String(text ?? "").trim();
  const emergency = classifySharedLineKeyword(body) === "EMERGENCY";
  const command = LEAVE.test(body) ? "leave" : JOIN.test(body) ? "join" : null;
  const addressed = ADDRESSED.test(body);

  const asksSomething = body.includes("?") || QUESTION_WORD.test(body.replace(/^@?prop\s?lane[,:]?\s*/i, ""));
  const houseQuestion = asksSomething && HOUSE_TOPIC.test(body);

  let flag: GroupFlag | null = null;
  let ruleTopic: GroupTextClass["ruleTopic"] = null;
  if (DISCRIM_WORDS.test(body)) flag = "discrimination";
  else if (HARASS_WORDS.test(body)) flag = "harassment";
  else if (SAFETY_WORDS.test(body)) flag = "safety";
  else if (NOISE.test(body) && (COMPLAINT.test(body) || /\b(please|stop|keep it down|turn it down|too loud)\b/i.test(body) || !asksSomething)) {
    flag = "rule";
    ruleTopic = "noise";
  } else if (SPACES.test(body) && (COMPLAINT.test(body) || !asksSomething)) {
    flag = "rule";
    ruleTopic = "spaces";
  } else if (GENERAL_RULE.test(body) && (COMPLAINT.test(body) || !asksSomething)) {
    flag = "rule";
    ruleTopic = "general";
  } else if (COMPLAINT.test(body)) flag = "complaint";

  return { addressed, emergency, houseQuestion, flag, ruleTopic, command };
}

export type RaContext = {
  now: Date;
  /** Group posts today (Pacific day) that count toward the cap. */
  postsToday: number;
  maxPostsPerDay: number;
  /** Rule flags in this house in the last 7 days, NOT counting this message. */
  recentRuleFlags: number;
  /** The house-fact question was already answered by a housemate (by the time a check fires). */
  answeredByPerson?: boolean;
};

export type RaPlan = {
  /** The emergency path: safety reply to the group + urgent team alert. Ignores quiet hours and the cap. */
  emergency: boolean;
  /** What to say in the group right now, if anything. */
  groupReply: null | "answer" | "complaint_ack" | "rules_reminder";
  /** Answer 1:1 instead (the daily cap or the cap-protected addressed path). */
  answerPrivately: boolean;
  /** Re-check at this time: answer a still-unanswered question / send the held follow-up. */
  checkAt: Date | null;
  /** Open a 1:1 with the author (a complaint, through the normal resident agent). */
  followUpPrivately: boolean;
  /** Tell the team, with the excerpt. */
  escalate: null | { category: "repeated_rules" | "safety" | "harassment" | "discrimination"; urgent: boolean };
  flag: GroupFlag | null;
  /** Why nothing was said in the group, for the log. */
  held: null | "quiet_hours" | "daily_cap";
};

function capReached(ctx: RaContext): boolean {
  return ctx.postsToday >= ctx.maxPostsPerDay;
}

/**
 * Decide what the RA does about ONE new group message. Never names or punishes anyone; a complaint,
 * safety, harassment or discrimination note goes to the team or a private thread, not back at the group.
 */
export function planGroupReply(cls: GroupTextClass, ctx: RaContext): RaPlan {
  const plan: RaPlan = {
    emergency: false,
    groupReply: null,
    answerPrivately: false,
    checkAt: null,
    followUpPrivately: false,
    escalate: null,
    flag: cls.flag,
    held: null,
  };

  if (cls.command) return plan; // handled by the leave/join path, no group post

  if (cls.emergency) {
    plan.emergency = true;
    plan.escalate = { category: "safety", urgent: true };
    return plan;
  }

  // Escalations never wait for the clock and never become group posts.
  if (cls.flag === "safety" || cls.flag === "harassment" || cls.flag === "discrimination") {
    plan.escalate = { category: cls.flag, urgent: cls.flag === "safety" };
    return plan;
  }

  const quiet = inHouseQuietHours(ctx.now);
  const capped = capReached(ctx);

  if (cls.flag === "rule") {
    const total = ctx.recentRuleFlags + 1;
    if (total >= RULE_ESCALATE_AT) plan.escalate = { category: "repeated_rules", urgent: false };
    plan.followUpPrivately = false;
    if (total >= RULE_REMINDER_AT && total < RULE_ESCALATE_AT) {
      if (quiet) plan.held = "quiet_hours";
      else if (capped) plan.held = "daily_cap";
      else plan.groupReply = "rules_reminder";
    }
    if (plan.escalate) return plan;
  }

  if (cls.flag === "complaint" || cls.flag === "rule") {
    plan.followUpPrivately = true;
    if (!quiet && !capped) plan.groupReply = plan.groupReply ?? "complaint_ack";
    else if (quiet) {
      plan.held = "quiet_hours";
      plan.checkAt = nextPacificMorning(ctx.now);
    } else plan.held = "daily_cap";
    // A rule reminder already chosen above is the group post; do not stack the acknowledgement on it.
    return plan;
  }

  if (cls.addressed || cls.houseQuestion) {
    if (cls.addressed) {
      if (quiet) {
        plan.held = "quiet_hours";
        plan.checkAt = nextPacificMorning(ctx.now);
      } else if (capped) {
        plan.held = "daily_cap";
        plan.answerPrivately = true;
      } else plan.groupReply = "answer";
      return plan;
    }
    // A house-fact question nobody addressed to PropLane: give housemates ten minutes first.
    plan.checkAt = new Date(ctx.now.getTime() + UNANSWERED_WAIT_MS);
    return plan;
  }

  return plan; // small talk: silent
}

/**
 * A scheduled check has come due for a held or unaddressed message: should the RA speak now?
 * `answeredByPerson` is true when any housemate posted after the question.
 */
export function planDueCheck(
  kind: "question" | "followup",
  ctx: RaContext,
): { act: "answer_group" | "answer_private" | "follow_up" | "skip" | "wait"; checkAt?: Date } {
  if (kind === "followup") return inHouseQuietHours(ctx.now) ? { act: "wait", checkAt: nextPacificMorning(ctx.now) } : { act: "follow_up" };
  if (ctx.answeredByPerson) return { act: "skip" };
  if (inHouseQuietHours(ctx.now)) return { act: "wait", checkAt: nextPacificMorning(ctx.now) };
  return capReached(ctx) ? { act: "answer_private" } : { act: "answer_group" };
}
