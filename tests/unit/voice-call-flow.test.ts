import { describe, expect, it } from "vitest";
import {
  buildCallFollowUpText,
  callerIsDone,
  callerWantsTextedLinks,
  linkNoteLines,
  linksToOffer,
  parseLinkNote,
  sanitizeForSpeech,
  spokenConsentDeclined,
  spokenConsentGivenLoosely,
} from "@/lib/voice/voice-call-flow";
import { twimlGatherSpeech, twimlGoodbye, resolveVoiceTurnWebhookUrl } from "@/lib/twilio-voice.server";
import { isGsm7 } from "@/lib/one-number/segments";

const ID = "mgr-listing-1x3tiu0489ha";
const LINKS = {
  listing: `https://proplane.ai/rent/listings/${ID}`,
  tour: `https://proplane.ai/rent/tours-contact?propertyId=${ID}`,
  apply: `https://proplane.ai/rent/apply?propertyId=${ID}`,
  browse: "https://proplane.ai/rent/browse",
};

describe("what a caller says", () => {
  it("knows when the caller is finished, and only on a short closing line", () => {
    for (const line of ["No, that's all", "nothing else, thanks", "No thank you", "goodbye", "I'm good", "bye"]) expect(callerIsDone(line), line).toBe(true);
    expect(callerIsDone("no I want a room under a thousand dollars near campus please")).toBe(false);
    expect(callerIsDone("")).toBe(false);
  });

  it("knows an explicit ask to be texted", () => {
    expect(callerWantsTextedLinks("can you text me the link")).toBe(true);
    expect(callerWantsTextedLinks("send me the application")).toBe(true);
    expect(callerWantsTextedLinks("how much is rent")).toBe(false);
  });

  it("reads consent: a yes or an okay continues, a no ends it, silence is neither", () => {
    expect(spokenConsentGivenLoosely("okay")).toBe(true);
    expect(spokenConsentGivenLoosely("sure that's fine")).toBe(true);
    expect(spokenConsentDeclined("no thanks")).toBe(true);
    expect(spokenConsentDeclined("")).toBe(false);
    expect(spokenConsentGivenLoosely("")).toBe(false);
  });
});

describe("which pages are texted after the call", () => {
  it("what the caller asked for decides it", () => {
    expect(linksToOffer({ speech: "can I tour it this weekend", reply: "Sure.", links: LINKS })).toEqual(["tour"]);
    expect(linksToOffer({ speech: "how do I apply", reply: "Online.", links: LINKS })).toEqual(["apply"]);
  });

  it("an explicit text-me, or the agent's own promise, sends the listing and the tour page", () => {
    expect(linksToOffer({ speech: "text me the link", reply: "Will do.", links: LINKS })).toEqual(["tour", "listing"]);
    expect(linksToOffer({ speech: "tell me about it", reply: "I will text you the details.", links: LINKS })).toEqual(["tour", "listing"]);
  });

  it("offers nothing the tools did not return", () => {
    expect(linksToOffer({ speech: "text me the link", reply: "ok", links: {} })).toEqual([]);
    expect(linksToOffer({ speech: "can I tour", reply: "ok", links: { tour: "http://localhost:3000/rent/tours-contact?propertyId=x" } })).toEqual([]);
  });

  it("the note lines round-trip to the follow-up text, and only our own pages survive", () => {
    const lines = linkNoteLines(LINKS, ["tour", "listing"]);
    const pages = parseLinkNote(["Links to text the caller after the call:", ...lines, "https://evil.example/rent/apply?propertyId=x"].join("\n"), "proplane.ai");
    expect(pages.map((p) => p.kind)).toEqual(["tour", "listing"]);
    const text = buildCallFollowUpText(pages);
    expect(text).toContain(LINKS.tour);
    expect(text).toContain(LINKS.listing);
    expect(text).not.toContain("evil.example");
    expect(isGsm7(text)).toBe(true);
    expect(text).not.toMatch(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/);
  });

  it("builds no text when nothing was offered", () => {
    expect(buildCallFollowUpText([])).toBe("");
  });
});

describe("TwiML", () => {
  it("a silent Gather hands the call back to the turn handler instead of going dead", () => {
    const xml = twimlGatherSpeech({ actionUrl: "https://x.test/turn?phase=agent", noInputUrl: "https://x.test/turn?phase=agent&attempt=1" });
    expect(xml).toMatch(/<\/Gather><Redirect method="POST">https:\/\/x.test\/turn\?phase=agent&amp;attempt=1<\/Redirect>/);
  });

  it("the attempt rides the signed turn URL", () => {
    expect(resolveVoiceTurnWebhookUrl("agent", "a".repeat(32), 1)).toContain("&attempt=1");
    expect(resolveVoiceTurnWebhookUrl("agent", "a".repeat(32))).not.toContain("attempt");
  });

  it("a goodbye says its words and hangs up", () => {
    expect(twimlGoodbye("Bye.")).toMatch(/<Say[^>]*>Bye\.<\/Say><Hangup\/>/);
  });

  it("speech never reads a web address aloud", () => {
    expect(sanitizeForSpeech("Here you go https://proplane.ai/rent/apply?propertyId=x thanks **a lot**")).toBe("Here you go the link I will text you thanks a lot");
  });
});
