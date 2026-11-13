import { classifyProspectIntents, isSendableProspectUrl, linkKindOfUrl, requiredLinkKinds } from "@/lib/prospect-replies";
import type { ProspectLinkKind, ProspectLinks } from "@/lib/prospect-replies";
import { toGsm7 } from "@/lib/one-number/segments";

/**
 * The words of a phone call that are not the agent's: the consent line, the goodbye, what to do with silence, and which
 * pages to text the caller afterwards. Pure: no database, no clock.
 */

export const VOICE_DISABLED_PROMPT =
  "The voice assistant is not enabled yet. Please text this number, or try again later.";
export const VOICE_CONSENT_PROMPT = "This call may be recorded to improve PropLane. Is that okay? Say yes to continue, or no to hang up.";
export const VOICE_CONSENT_REASK = "Sorry, I did not catch that. Is it okay if this call is recorded? Say yes to continue, or no to hang up.";
export const VOICE_REPROMPT = "I did not catch that. What can I help you with?";
export const VOICE_DECLINED_GOODBYE = "No problem. You can text this number any time. Goodbye.";
export const VOICE_UNREACHABLE = "Sorry, I am having trouble right now. I will text you a link, and a teammate will follow up. Goodbye.";
/** Silence on a re-ask ends the call. */
export const MAX_SILENT_ATTEMPTS = 2;

const DONE = /\b(that'?s (all|it)|that is (all|it)|nothing (else|more)|no,? (thanks?|thank you)|no$|nope|i'?m (good|all set|done)|all set|goodbye|good ?bye|bye|talk to you later|that will be all)\b/;
const WANTS_TEXT = /\b(text|send|message|email|shoot)\b.{0,24}\b(me|us|it|that|them|those|the link|a link|links?)\b|\b(link|links)\b.{0,16}\b(text|send)\b/;

export function callerIsDone(speech: string): boolean {
  const text = String(speech ?? "").toLowerCase().replace(/[.!?,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return text.split(" ").length <= 8 && DONE.test(text);
}

export function callerWantsTextedLinks(speech: string): boolean {
  return WANTS_TEXT.test(String(speech ?? "").toLowerCase());
}

/** A spoken "no" to the recording line, as opposed to an unclear answer. */
export function spokenConsentDeclined(speech: string): boolean {
  return /^(no|nope|nah|negative|don'?t|do not|hang up|i do not|i don'?t)\b/.test(String(speech ?? "").trim().toLowerCase());
}

/** "okay", "sure" and "that's fine" are consent on the recording line; the generic confirm vocabulary does not carry them. */
export function spokenConsentGivenLoosely(speech: string): boolean {
  return /^(ok|okay|sure|fine|alright|all right|continue|go on|that'?s fine|that is fine|no problem)\b/.test(String(speech ?? "").trim().toLowerCase());
}

const OFFER_ORDER: readonly ProspectLinkKind[] = ["tour", "apply", "stay", "listing", "browse"];

/**
 * The pages to text a caller after the call. What they asked for decides it (the same intent table the text replies use),
 * an explicit "text me" or the agent's own promise adds the listing and the tour page, and a matched home is required:
 * the links come from the tools' own results for that home, never from the words spoken.
 */
export function linksToOffer(input: { speech: string; reply: string; links: ProspectLinks }): ProspectLinkKind[] {
  const intents = classifyProspectIntents(input.speech);
  const wanted = new Set<ProspectLinkKind>(requiredLinkKinds(intents, input.links));
  const promised = /\b(text|send)\b.{0,30}\b(you|link|links|it|that)\b/i.test(input.reply);
  if (callerWantsTextedLinks(input.speech) || promised) {
    for (const kind of ["listing", "tour"] as const) wanted.add(kind);
  }
  return OFFER_ORDER.filter((kind) => wanted.has(kind) && isSendableProspectUrl(input.links[kind]));
}

const LABEL: Record<ProspectLinkKind, string> = {
  listing: "Listing",
  tour: "Pick a tour time",
  apply: "Apply (free)",
  stay: "Request a short stay",
  browse: "See all homes",
  message: "Message the manager",
};

/** One "Label: url" line per page, the exact text the inbox note carries. */
export function linkNoteLines(links: ProspectLinks, kinds: readonly ProspectLinkKind[]): string[] {
  return kinds.filter((kind) => isSendableProspectUrl(links[kind])).map((kind) => `${LABEL[kind]}: ${links[kind]}`);
}

/** Read the pages back out of a link note: only https URLs that are one of our own page kinds survive. */
export function parseLinkNote(body: string, allowedHost: string): Array<{ kind: ProspectLinkKind; url: string }> {
  const out: Array<{ kind: ProspectLinkKind; url: string }> = [];
  for (const match of String(body ?? "").matchAll(/https:\/\/[^\s<>"']+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    const kind = linkKindOfUrl(url);
    if (!kind || !isSendableProspectUrl(url)) continue;
    try {
      if (new URL(url).host !== allowedHost) continue;
    } catch {
      continue;
    }
    out.push({ kind, url });
  }
  return out;
}

/**
 * The follow-up text. Plain GSM-7, signed as PropLane (never a person), one line per page, and no phone number: the
 * pages are the web channel.
 */
export function buildCallFollowUpText(pages: ReadonlyArray<{ kind: ProspectLinkKind; url: string }>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const page of pages) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    lines.push(`${LABEL[page.kind]}: ${page.url}`);
  }
  if (lines.length === 0) return "";
  return toGsm7(["Thanks for calling PropLane. The links we talked about:", ...lines].join("\n"));
}

/** What the caller hears when the agent could not answer: a promise that is kept by the post-call text. */
export function unreachableFallbackLinks(browseUrl: string): ProspectLinks {
  return { browse: browseUrl };
}

/** A reply is heard, not read: no web address, no markdown, nothing a speech engine would spell out. */
export function sanitizeForSpeech(reply: string): string {
  return String(reply ?? "")
    .replace(/https?:\/\/\S+/g, "the link I will text you")
    .replace(/[*_#`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
