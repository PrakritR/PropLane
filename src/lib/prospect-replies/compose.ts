import { stripSmsMarkdown } from "@/lib/agent/conversation-style-rules";
import { smsSegmentCount, toGsm7 } from "@/lib/one-number/segments";
import { classifyProspectIntents, prospectIntentDef } from "@/lib/prospect-replies/intents";
import type {
  ProspectIntentId,
  ProspectLinkKind,
  ProspectLinks,
  ProspectReply,
  ProspectReplyFacts,
} from "@/lib/prospect-replies/types";

/** Two segments is the target, three the ceiling: past that the answer is cut before a link is. */
export const PROSPECT_REPLY_TARGET_SEGMENTS = 2;
export const PROSPECT_REPLY_MAX_SEGMENTS = 3;
/** A reply carries at most this many links unless the prospect asked for more than one thing. */
const MAX_LINKS = 2;

const DEFAULT_LABEL: Record<ProspectLinkKind, string> = {
  listing: "Listing",
  tour: "Pick a tour time",
  apply: "Apply",
  stay: "Request a short stay",
  browse: "See all homes",
  message: "Message the manager",
};

/** Action links first (the thing they want to do), then the page that explains. */
const LINK_ORDER: readonly ProspectLinkKind[] = ["tour", "apply", "stay", "listing", "browse", "message"];

function joinTopics(topics: string[]): string {
  if (topics.length <= 1) return topics[0] ?? "";
  return `${topics.slice(0, -1).join(", ")} and ${topics[topics.length - 1]}`;
}

/** A link a prospect's phone cannot open (or must never be sent) is dropped, never texted. */
export function isSendableProspectUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  return true;
}

/** Which kind of page does this URL point at? Null for anything that is not one of ours. */
export function linkKindOfUrl(url: string): ProspectLinkKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/\/$/, "");
  if (/\/applications\/stay$/.test(path)) return "stay";
  if (path.endsWith("/rent/tours-contact")) return parsed.searchParams.get("tab") === "message" ? "message" : "tour";
  if (path.endsWith("/rent/apply")) return "apply";
  if (path.endsWith("/rent/browse")) return "browse";
  if (/\/rent\/listings\/[^/]+$/.test(path)) return "listing";
  return null;
}

function urlsIn(text: string): string[] {
  return [...String(text ?? "").matchAll(/https?:\/\/[^\s<>"')]+/g)].map((match) => match[0].replace(/[.,;:!?]+$/, ""));
}

export function linkKindsPresentIn(text: string): Set<ProspectLinkKind> {
  const out = new Set<ProspectLinkKind>();
  for (const url of urlsIn(text)) {
    const kind = linkKindOfUrl(url);
    if (kind) out.add(kind);
  }
  return out;
}

/** The link kinds these intents want, in send order, limited to the kinds that exist. */
export function requiredLinkKinds(intents: readonly ProspectIntentId[], available: ProspectLinks, options: { strict?: boolean } = {}): ProspectLinkKind[] {
  const wanted = new Set<ProspectLinkKind>();
  for (const id of intents) {
    // The first link that exists wins per intent: a short stay with no stay link falls back to the listing page.
    const kinds = prospectIntentDef(id).links;
    const present = kinds.find((kind) => isSendableProspectUrl(available[kind]));
    if (present) wanted.add(present);
    else if (options.strict) continue;
    else if (isSendableProspectUrl(available.listing)) wanted.add("listing");
    else if (isSendableProspectUrl(available.browse)) wanted.add("browse");
  }
  return LINK_ORDER.filter((kind) => wanted.has(kind));
}

function linkLine(kind: ProspectLinkKind, url: string, intents: readonly ProspectIntentId[], facts: ProspectReplyFacts | null): string {
  let label = DEFAULT_LABEL[kind];
  for (const id of intents) {
    const custom = prospectIntentDef(id).linkLabel?.[kind];
    if (custom) {
      label = custom;
      break;
    }
  }
  if (kind === "apply" && facts?.applicationFee?.free) label = "Apply (free)";
  return `${label}: ${url}`;
}

/**
 * The deterministic reply: a short grounded answer from the listing facts, then the pages that let the prospect act.
 * It runs when the model is unavailable or its answer could not be shown, and it is the reference the fixture suite pins.
 * It never states a fact the input does not carry; an intent the facts cannot answer is folded into one honest sentence
 * and the listing page is sent instead.
 */
export function composeProspectReply(input: {
  message: string;
  facts: ProspectReplyFacts | null;
  links: ProspectLinks;
  /**
   * The prospect's first text on the line. Most listing sites forbid links in the ad, so this reply is where they get the
   * house's pages: the listing, the tour page and the application ride along with whatever else they asked.
   */
  firstReply?: boolean;
}): ProspectReply {
  const { facts, links } = input;
  const intents = classifyProspectIntents(input.message);
  const answers: string[] = [];
  const unanswered: ProspectIntentId[] = [];
  for (const id of intents) {
    const def = prospectIntentDef(id);
    const line = facts ? def.answer(facts) : null;
    if (line === null) unanswered.push(id);
    else if (line) answers.push(line);
  }

  // With nothing recognised, a prospect with a matched home gets the listing, one with none gets the browse page.
  const effective: ProspectIntentId[] = intents.length > 0 ? intents : isSendableProspectUrl(links.listing) ? ["photos"] : ["browse"];
  let kinds = requiredLinkKinds(effective, links);
  if (kinds.length === 0 && isSendableProspectUrl(links.browse)) kinds = ["browse"];
  const wantsOnlyOneThing = intents.length <= 1 && !input.firstReply;
  const requiredCount = kinds.length;
  if (input.firstReply) {
    // What they asked for first, then the house's other pages, up to three.
    const extra = (["tour", "apply", "listing"] as const).filter((kind) => isSendableProspectUrl(links[kind]) && !kinds.includes(kind));
    kinds = [...kinds, ...extra];
  }
  kinds = kinds.slice(0, input.firstReply ? 3 : wantsOnlyOneThing ? MAX_LINKS : MAX_LINKS + 1);

  const askedTopics = [...new Set(unanswered.map((id) => prospectIntentDef(id).topic))].slice(0, 3);
  const confirmLine = askedTopics.length > 0 ? `I'll confirm ${joinTopics(askedTopics)} with the manager.` : "";

  const render = (answerLines: string[], withConfirm: boolean, linkKinds: ProspectLinkKind[]) => {
    const lines = [
      [...answerLines, withConfirm ? confirmLine : ""].filter(Boolean).join(" "),
      ...linkKinds.map((kind) => linkLine(kind, links[kind] as string, effective, facts)),
    ].filter(Boolean);
    return toGsm7(lines.join("\n"));
  };

  // Trim to the segment ceiling: the closing confirm line goes first, then trailing answers, then the least useful link.
  let useAnswers = answers.slice(0, 3);
  let useConfirm = confirmLine !== "";
  let useKinds = kinds;
  let text = render(useAnswers, useConfirm, useKinds);
  while (smsSegmentCount(text) > PROSPECT_REPLY_MAX_SEGMENTS) {
    // The house's other pages are a courtesy: they go before the honest "I'll confirm" line does.
    if (useKinds.length > Math.max(1, requiredCount)) useKinds = useKinds.slice(0, -1);
    else if (useConfirm) useConfirm = false;
    else if (useAnswers.length > 1) useAnswers = useAnswers.slice(0, -1);
    else if (useKinds.length > 1) useKinds = useKinds.slice(0, -1);
    else if (useAnswers.length > 0) useAnswers = [];
    else break;
    text = render(useAnswers, useConfirm, useKinds);
  }
  return { text, intents, links: useKinds, unanswered };
}

/**
 * The link guard for a reply the model already wrote. If the prospect asked for something that has a page (a tour, the
 * application, the listing) and the reply carries no link of that kind, the real link from the turn's tool results is
 * appended on its own line. Never adds a link the tools did not return, never more than two, never touches a reply that
 * is a confirmation question or an empty (quiet-handoff) reply.
 */
export function ensureProspectReplyLinks(input: {
  reply: string;
  message: string;
  links: ProspectLinks;
  facts?: ProspectReplyFacts | null;
}): { text: string; appended: ProspectLinkKind[] } {
  const reply = String(input.reply ?? "").trim();
  if (!reply) return { text: reply, appended: [] };
  // A reply that asks the prospect to confirm a booking or answers a sign-up is a conversation step, not a link moment.
  if (/\breply (yes|y)\b|\b(yes|confirm)\b.{0,40}\bto (confirm|book)\b/i.test(reply)) return { text: reply, appended: [] };
  // A clarifying question ("which home do you mean?") is waiting on the prospect: the links come with the answer.
  if (/\?\s*$/.test(reply) || /\b(select|choose|pick|tell me)\b[^.?!]{0,30}\b(home|house|room|one|address)\b/i.test(reply)) return { text: reply, appended: [] };
  const intents = classifyProspectIntents(input.message);
  if (intents.length === 0) return { text: reply, appended: [] };
  // Strict: a guard adds the page the prospect asked for, never a different page standing in for one that does not exist.
  const required = requiredLinkKinds(intents, input.links, { strict: true });
  const present = linkKindsPresentIn(reply);
  const missing = required.filter((kind) => !present.has(kind));
  // The listing page is a courtesy next to an action link the reply already carries.
  const actionPresent = ["tour", "apply", "stay"].some((kind) => present.has(kind as ProspectLinkKind));
  const trimmed = missing.filter((kind) => !(kind === "listing" && actionPresent));
  const toAdd = trimmed.slice(0, MAX_LINKS);
  if (toAdd.length === 0) return { text: reply, appended: [] };
  const lines = toAdd.map((kind) => linkLine(kind, input.links[kind] as string, intents, input.facts ?? null));
  return { text: `${reply}\n${toGsm7(lines.join("\n"))}`, appended: toAdd };
}

/** The property id a minted tour, apply, message or stay link is keyed on. */
function propertyIdOfLink(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("propertyId") || parsed.searchParams.get("listing");
  } catch {
    return null;
  }
}

const KEYED_KINDS: readonly ProspectLinkKind[] = ["tour", "apply", "message", "stay"];

/**
 * A link in the reply that points at a DIFFERENT home than the one this turn matched is the rotated-links bug (the three
 * houses' links went out on the wrong houses). Every tour, apply, message and stay link carries its property id, so each one
 * that names another id is replaced by the matched home's link of the same kind (or dropped when there is none). A single
 * listing page that is not the matched home's is replaced the same way; a reply naming several homes is left alone, since
 * listing several homes is legitimate. The matched home comes from this turn's own tool results, never from the text.
 */
export function fixRotatedHomeLinks(reply: string, links: ProspectLinks): { text: string; fixed: number } {
  const matched = propertyIdOfLink(links.tour) ?? propertyIdOfLink(links.apply) ?? propertyIdOfLink(links.message);
  if (!matched) return { text: reply, fixed: 0 };
  let fixed = 0;
  let text = reply;
  for (const url of new Set(urlsIn(reply))) {
    const kind = linkKindOfUrl(url);
    if (!kind || !KEYED_KINDS.includes(kind)) continue;
    const id = propertyIdOfLink(url);
    if (!id || id === matched) continue;
    const replacement = links[kind];
    text = text.split(url).join(isSendableProspectUrl(replacement) ? replacement : "");
    fixed += 1;
  }
  const listingUrls = [...new Set(urlsIn(text).filter((url) => linkKindOfUrl(url) === "listing"))];
  if (listingUrls.length === 1 && isSendableProspectUrl(links.listing) && listingUrls[0] !== links.listing) {
    text = text.split(listingUrls[0]!).join(links.listing);
    fixed += 1;
  }
  return { text: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), fixed };
}

/** "No tour slots published" is never true of a home with a tour page: the page takes requests for any day. */
const NO_SLOTS_CLAIM = /[^.!?\n]*\b(no|zero|not any|nothing)\b[^.!?\n]{0,40}\b(tour )?(slots?|times?|openings?|availability)\b[^.!?\n]{0,40}\b(published|available|open|listed|right now|currently)\b[^.!?\n]*[.!?]?|[^.!?\n]*\bnothing (is )?(open|available) for tours?\b[^.!?\n]*[.!?]?/i;

/** A trailing "- Name" sign-off makes the line read as a person (the owner), not PropLane. */
const PERSON_SIGN_OFF = /\n[ \t]*[-~–—]{1,2}[ \t]*[A-Z][a-z]+(?: [A-Z][a-z]+){0,2}[ \t]*$/;

/**
 * The last pass over a prospect reply the model wrote, before it is sent. All of it is deterministic and reads only this
 * turn's tool results: plain text (no markdown), no person's sign-off, every link keyed to the home the turn matched, a
 * working tour link instead of a "no slots" claim or the retired /rent/tour address, and the link the prospect asked for.
 */
export function finalizeProspectReply(input: {
  reply: string;
  message: string;
  links: ProspectLinks;
  facts?: ProspectReplyFacts | null;
}): { text: string; changes: string[] } {
  const changes: string[] = [];
  let text = String(input.reply ?? "").trim();
  if (!text) return { text, changes };
  const plain = stripSmsMarkdown(text).replace(/\*{1,3}([^*\n]+?)\*{1,3}/g, "$1").replace(/\*+/g, "");
  if (plain !== text) changes.push("markdown");
  text = plain;
  // A reply to someone who texted us is a person texting back: no "This is PropLane" opener, no STOP footer.
  const direct = text
    .replace(/^(?:hi|hello|hey)\b[!,.]?\s*(?:this is|it'?s|you'?ve reached)\s+proplane\b[.!,:]?\s*/i, "")
    .replace(/^proplane here\b[.!,:]?\s*/i, "")
    .replace(/\s*reply stop to opt out\.?\s*$/i, "");
  if (direct !== text) changes.push("preamble_or_footer");
  text = direct;
  const unsigned = text.replace(PERSON_SIGN_OFF, "");
  if (unsigned !== text) changes.push("sign_off");
  text = unsigned.trim();

  const tour = input.links.tour;
  if (isSendableProspectUrl(tour)) {
    if (NO_SLOTS_CLAIM.test(text)) {
      const without = text.replace(NO_SLOTS_CLAIM, "").replace(/\s{2,}/g, " ").trim();
      text = linkKindsPresentIn(without).has("tour") ? without : `${without ? `${without}\n` : ""}Pick a tour time: ${tour}`;
      changes.push("no_slots_claim");
    }
    const retired = text.replace(/https?:\/\/[^\s]+\/rent\/tour(?=[\s.,;:!?)]|$)/g, tour);
    if (retired !== text) {
      text = retired;
      changes.push("retired_tour_link");
    }
  }

  const rotated = fixRotatedHomeLinks(text, input.links);
  if (rotated.fixed > 0) {
    text = rotated.text;
    changes.push("rotated_links");
  }
  const ensured = ensureProspectReplyLinks({ reply: text, message: input.message, links: input.links, facts: input.facts });
  if (ensured.appended.length > 0) changes.push(`appended:${ensured.appended.join(",")}`);
  return { text: ensured.text, changes };
}
