import type { HouseInfoSectionId, HouseInfoV1 } from "@/lib/house-info";
import { classifyIntentHeuristic } from "@/lib/one-number/intent";
import { tokenize } from "@/lib/one-number/knowledge/ranking";
import { detectAlwaysEscalate } from "@/lib/one-number/knowledge/topics";
import { smsSegmentCount, toGsm7 } from "@/lib/one-number/segments";

/**
 * Resident fast path: the top house questions answered from stored facts, no
 * model, in one short bubble (target under 3 s). Pure: the server wrapper does
 * the scoping (a verified current resident of THAT house) and hands the facts in.
 *
 * It answers only when the text is obviously one of these questions and every
 * fact it needs is on file. Anything else (a complaint, money, a maintenance
 * problem, a topic with no fact, a reply that would not fit one bubble) returns
 * null and the normal agent runs. A wrong fast answer is worse than a slow one.
 */

export type FastPathKnowledge = { question: string; answer: string };

export type FastPathFacts = {
  /** House details; null when this resident may not read them yet (pre move-in lock). */
  houseInfo: HouseInfoV1 | null;
  /** Approved Q&A for this house / the team, audience already filtered. */
  knowledge: readonly FastPathKnowledge[];
};

export type FastPathTopic =
  | "wifi" | "door_code" | "parking" | "trash" | "laundry" | "quiet_hours" | "guests" | "smoking" | "pets" | "contact" | "group_chat" | "knowledge";

export type FastPathAnswer = { reply: string; topics: FastPathTopic[] };

const MAX_TEXT_CHARS = 160;
const MAX_QUESTION_MARKS = 2;

const TOPICS: { topic: Exclude<FastPathTopic, "knowledge">; pattern: RegExp }[] = [
  { topic: "wifi", pattern: /\b(wi-?fi|wifi|wireless|internet|network name)\b/i },
  { topic: "door_code", pattern: /\b(door code|front door|gate code|key ?code|lock ?box|code to (get|go|come) in|code for the (door|gate)|alarm code|how (do|can) i (get|go) in)\b/i },
  { topic: "parking", pattern: /\b(parking|park (my|the|a|our)\b|where (can|do|should) i park)/i },
  { topic: "trash", pattern: /\b(trash|garbage|rubbish|bins?|recycl\w*|compost)\b/i },
  { topic: "laundry", pattern: /\b(laundry|washer|dryer|washing machine)\b/i },
  { topic: "quiet_hours", pattern: /\bquiet hours?|noise (rules?|curfew|hours)\b/i },
  { topic: "guests", pattern: /\b(guests?|overnight|visitors?|friends? (over|stay))\b/i },
  { topic: "smoking", pattern: /\b(smok\w*|vap(e|ing)|cannabis|weed)\b/i },
  { topic: "pets", pattern: /\b(pets?|dogs?|cats?)\b/i },
  { topic: "contact", pattern: /\b(emergency (number|contact|line)|after[- ]hours|who (do|should|can) i (call|contact|text)|manager'?s? (number|phone|contact)|on-?site)\b/i },
  { topic: "group_chat", pattern: /\b(group chat|house chat|group text)\b/i },
];

function value(info: HouseInfoV1, section: HouseInfoSectionId, keys: readonly string[]): string {
  const bag = info[section] as Record<string, string> | undefined;
  for (const key of keys) {
    const v = bag?.[key]?.trim();
    if (v) return v;
  }
  return "";
}

/** One fact line for a topic, or null when the facts on file cannot answer it. */
function factFor(topic: Exclude<FastPathTopic, "knowledge">, info: HouseInfoV1, text: string): string | null {
  switch (topic) {
    case "wifi": {
      const network = value(info, "wifi", ["network", "ssid"]);
      const password = value(info, "wifi", ["password"]);
      if (network && password) return `Wi-Fi: ${network}, password ${password}.`;
      if (network) return `Wi-Fi network is ${network}.`;
      return null;
    }
    case "door_code": {
      const door = value(info, "access", ["doorCode"]);
      const gate = value(info, "access", ["gateCode"]);
      const key = value(info, "access", ["keyPickup"]);
      const parts = [door && `Door code ${door}`, gate && `gate ${gate}`].filter(Boolean) as string[];
      if (parts.length) return `${parts.join(", ")}.`;
      return key ? `${key.replace(/[.!]+$/, "")}.` : null;
    }
    case "parking": {
      const parking = value(info, "access", ["parking"]);
      return parking ? `Parking: ${parking.replace(/[.!]+$/, "")}.` : null;
    }
    case "trash": {
      const day = value(info, "trash", ["day"]);
      const recycling = value(info, "trash", ["recyclingDay", "recycleDay", "recycling"]);
      const bins = value(info, "trash", ["binLocation"]);
      const asksRecycling = /recycl|compost/i.test(text);
      const asksWhere = /\bwhere\b/i.test(text) && bins;
      const parts: string[] = [];
      if (asksRecycling) {
        if (!recycling) return null;
        parts.push(`Recycling day is ${recycling}`);
        if (day) parts.push(`trash is ${day}`);
      } else {
        if (!day && !asksWhere) return null;
        if (day) parts.push(`Trash day is ${day}`);
        if (recycling) parts.push(`recycling is ${recycling}`);
      }
      if (asksWhere) parts.push(`bins: ${bins}`);
      const line = parts.join(", ");
      return line ? `${line}.` : null;
    }
    case "laundry": {
      const where = value(info, "laundry", ["location"]);
      const hours = value(info, "laundry", ["hours"]);
      if (!where && !hours) return null;
      return `Laundry: ${[where, hours && `open ${hours}`].filter(Boolean).join(", ")}.`;
    }
    case "quiet_hours": {
      const from = value(info, "rules", ["quietFrom"]);
      const to = value(info, "rules", ["quietTo"]);
      return from && to ? `Quiet hours are ${from} to ${to}.` : null;
    }
    case "guests": {
      const guests = value(info, "rules", ["guests"]);
      return guests ? `Guests: ${guests.replace(/[.!]+$/, "")}.` : null;
    }
    case "smoking": {
      const smoking = value(info, "rules", ["smoking"]);
      return smoking ? `Smoking: ${smoking.replace(/[.!]+$/, "")}.` : null;
    }
    case "pets": {
      const pets = value(info, "rules", ["pets"]);
      return pets ? `Pets: ${pets.replace(/[.!]+$/, "")}.` : null;
    }
    case "contact": {
      const emergency = value(info, "contacts", ["emergency"]);
      const manager = value(info, "contacts", ["managerPhone", "manager", "managerContact"]);
      const onSite = value(info, "contacts", ["onSite"]);
      const parts = [manager && `Manager ${manager}`, emergency && `after hours ${emergency}`, onSite && `on site ${onSite}`].filter(Boolean) as string[];
      return parts.length ? `${parts.join(", ")}.` : null;
    }
    case "group_chat": {
      const url = value(info, "contacts", ["groupChatUrl"]);
      return url ? `House chat: ${url}` : null;
    }
  }
}

/** An approved Q&A whose question covers most of what was asked. */
function knowledgeAnswer(text: string, entries: readonly FastPathKnowledge[]): string | null {
  const asked = [...new Set(tokenize(text))];
  if (asked.length === 0) return null;
  let best: { answer: string; coverage: number; shared: number } | null = null;
  for (const entry of entries) {
    const known = new Set(tokenize(entry.question));
    const shared = asked.filter((token) => known.has(token)).length;
    const coverage = shared / asked.length;
    if (shared >= Math.min(2, asked.length) && coverage >= 0.6 && (!best || coverage > best.coverage || (coverage === best.coverage && shared > best.shared))) {
      best = { answer: entry.answer.trim(), coverage, shared };
    }
  }
  return best?.answer || null;
}

/** The fast answer for `text`, or null to let the agent run. */
export function matchResidentFastPath(text: string, facts: FastPathFacts): FastPathAnswer | null {
  const body = String(text ?? "").trim();
  if (!body || body.length > MAX_TEXT_CHARS) return null;
  if ((body.match(/\?/g) ?? []).length > MAX_QUESTION_MARKS) return null;
  if (detectAlwaysEscalate(body)) return null;
  // Only a house-fact question: a complaint, rent, a repair or a request for a person is the agent's.
  const intent = classifyIntentHeuristic(body);
  if (intent !== null && intent !== "faq") return null;

  const info = facts.houseInfo;
  const matched = TOPICS.filter((t) => t.pattern.test(body)).map((t) => t.topic);
  if (matched.length > 0) {
    // A topic needs its fact. A door code with no code on file is the agent's to escalate, not ours to guess.
    if (!info) return null;
    const lines: string[] = [];
    for (const topic of matched) {
      const line = factFor(topic, info, body);
      if (!line) return null;
      lines.push(line);
    }
    return finalize(lines.join(" "), matched);
  }

  const answer = knowledgeAnswer(body, facts.knowledge);
  return answer ? finalize(answer, ["knowledge"]) : null;
}

function finalize(reply: string, topics: FastPathTopic[]): FastPathAnswer | null {
  const text = toGsm7(reply).trim();
  // One short bubble. A fact that does not fit is not "fast"; hand it to the agent.
  if (!text || smsSegmentCount(text) > 1) return null;
  return { reply: text, topics };
}

/**
 * Cheap pre-check before any database read: is this text even shaped like a house
 * question? Keeps "ok thanks" and "the sink is leaking" from costing a scope lookup.
 */
export function isFastPathCandidate(text: string): boolean {
  const body = String(text ?? "").trim();
  if (!body || body.length > MAX_TEXT_CHARS) return false;
  if ((body.match(/\?/g) ?? []).length > MAX_QUESTION_MARKS) return false;
  const intent = classifyIntentHeuristic(body);
  if (intent !== null && intent !== "faq") return false;
  if (detectAlwaysEscalate(body)) return false;
  return TOPICS.some((t) => t.pattern.test(body)) || /\?|^(what|where|when|how|who|can|could|is|are|do|does|may)\b/i.test(body);
}
