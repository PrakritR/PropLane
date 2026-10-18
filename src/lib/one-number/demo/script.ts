/**
 * The DEMO step machine. Pure: (state, text) -> (state, bubbles). No database, no clock, no model.
 * Three scripted moments on the sample house (an applicant books a tour, a leak is dispatched
 * with a Y/N approval, rent reminders go out), then up to three questions about the user's real
 * house, then the finish-setup link. The words are PropLane's voice; the numbers come from
 * `DEMO_SAMPLE_HOUSE`, a fixture. Every line is one GSM-7 segment (no emoji, no curly quotes).
 */
import { DEMO_SAMPLE_HOUSE as H } from "@/lib/demo/demo-sms-sample-house";
import { extractHouseHints, extractRent, extractRoomCount, mergeHints, parseCount } from "@/lib/one-number/onboarding/role-detect";
import type { DemoBubble, DemoHints, DemoState, DemoStep } from "@/lib/one-number/demo/types";

/** Replaced by the server with the minted finish-setup URL. */
export const FINISH_URL_TOKEN = "{{FINISH_URL}}";

export const DEMO_COPY = {
  intro: `Hi, this is the PropLane demo. Sample house: ${H.address}, 3 rooms, 2 residents. Nothing here is real. Reply STOP anytime.`,
  m1: `Moment 1 of 3. ${H.applicant.name} texted me: "Is ${H.applicant.room} available?" I gave the rent and dates, and ${H.applicant.name} picked ${H.applicant.tourLabel}.`,
  m1Sample: `Tour booked: ${H.applicant.name}, ${H.applicant.room}, ${H.applicant.tourLabel} at ${H.address}. Reply C to change it.`,
  m1End: "That is the text you get. I did the rest. Reply NEXT for moment 2.",
  m2: `Moment 2 of 3. Sam in Room 2 texted: "The kitchen sink is leaking." I found a plumber, and I ask you first. Your text:`,
  m2Sample: `Leak at 61 Willow Ct, Rm 2. Send ${H.vendor.name}, est $${H.vendor.estimate}? Reply Y or N.`,
  m2End: "Your turn. Reply Y to approve.",
  m2Retry: "Reply Y to approve the plumber or N to hold it.",
  approved: `Approved. Pat accepted for ${H.vendor.slot} and I told Sam. Moment 3 of 3: rent is due ${H.rentDueLabel}, so I texted Maya and Sam, each privately:`,
  held: `Held. I would not send anyone and I would ask you again in an hour. Moment 3 of 3: rent is due ${H.rentDueLabel}, so I texted Maya and Sam:`,
  m3Sample: `Hi Maya, your $${H.rooms[0].rent} rent is due ${H.rentDueLabel}. Pay here: [your pay link]`,
  m3End: "Reply NEXT to finish.",
  askAddress: "That is the demo. Now your real house. What is the street address of your first property? Reply SKIP to do it later.",
  askAddressRetry: "I need the street address, like 61 Willow Court. Or reply SKIP.",
  askRooms: "Got it. How many rooms does it have?",
  askRoomsRetry: "Just a number is fine, like 4. Or reply SKIP.",
  askRent: "And about what is the rent per room? Reply SKIP if unsure.",
  askRentRetry: "A number is fine, like 850. Or reply SKIP.",
  finish: `Want this for your real properties? Tap to finish setup: ${FINISH_URL_TOKEN}`,
  finishAgain: "Reply DEMO to run it again.",
  ended: "Demo ended. Text DEMO anytime to run it again.",
} as const;

let counter = 0;
const bubble = (kind: DemoBubble["kind"], text: string, step: DemoStep): DemoBubble => ({ id: `${step}-${counter++}`, kind, text });

export type DemoAdvance = {
  state: DemoState;
  bubbles: DemoBubble[];
  /** The user ended the demo. */
  ended: boolean;
  /** The setup questions are over: mint the finish link and put it where `FINISH_URL_TOKEN` is. */
  finish: boolean;
};

const END_COMMAND = /^(exit|quit|end|end demo|cancel|stop|stop demo|leave|quit demo)$/i;
const YES = /^(y|yes|yep|yeah|yup|ok|okay|approve|approved|send|sure|do it|go ahead)\b/i;
const NO = /^(n|no|nope|nah|hold|wait|dont|don't|not now)\b/i;
const SKIP = /^(skip|later|not now|no|nope|pass|none|n\/a)\b/i;

export function demoEndCommand(text: string): boolean {
  return END_COMMAND.test(text.trim().replace(/[.!]+$/, ""));
}

function stay(state: DemoState, bubbles: DemoBubble[], patch: Partial<DemoState> = {}): DemoAdvance {
  return { state: { ...state, ...patch }, bubbles, ended: false, finish: false };
}

/** The first turn: the intro and moment 1. `hints` are whatever the user volunteered before the demo. */
export function startDemo(hints: DemoHints = {}): DemoAdvance {
  const state: DemoState = { step: "applicant", hints, strikes: 0 };
  return stay(state, [
    bubble("agent", DEMO_COPY.intro, "applicant"),
    bubble("agent", DEMO_COPY.m1, "applicant"),
    bubble("sample", DEMO_COPY.m1Sample, "applicant"),
    bubble("agent", DEMO_COPY.m1End, "applicant"),
  ]);
}

function momentTwo(state: DemoState): DemoAdvance {
  return stay(state, [bubble("agent", DEMO_COPY.m2, "leak"), bubble("sample", DEMO_COPY.m2Sample, "leak"), bubble("agent", DEMO_COPY.m2End, "leak")], { step: "leak", strikes: 0 });
}

function momentThree(state: DemoState, lead: string): DemoAdvance {
  return stay(state, [bubble("agent", lead, "rent"), bubble("sample", DEMO_COPY.m3Sample, "rent"), bubble("agent", DEMO_COPY.m3End, "rent")], { step: "rent", strikes: 0 });
}

/** The next unanswered question about the user's real house, or the finish. */
function nextQuestion(state: DemoState): DemoAdvance {
  const { hints } = state;
  if (!hints.address) return stay(state, [bubble("agent", DEMO_COPY.askAddress, "ask_address")], { step: "ask_address", strikes: 0 });
  if (!hints.rooms) return stay(state, [bubble("agent", DEMO_COPY.askRooms, "ask_rooms")], { step: "ask_rooms", strikes: 0 });
  if (!hints.rent) return stay(state, [bubble("agent", DEMO_COPY.askRent, "ask_rent")], { step: "ask_rent", strikes: 0 });
  return finishDemo(state);
}

function finishDemo(state: DemoState): DemoAdvance {
  return {
    state: { ...state, step: "finished", strikes: 0 },
    bubbles: [bubble("agent", DEMO_COPY.finish, "finished"), bubble("agent", DEMO_COPY.finishAgain, "finished")],
    ended: false,
    finish: true,
  };
}

/** Feed one user text into the machine. */
export function advanceDemo(state: DemoState, rawText: string): DemoAdvance {
  const text = rawText.trim();
  if (demoEndCommand(text)) {
    return { state: { ...state, step: "ended" }, bubbles: [bubble("agent", DEMO_COPY.ended, "ended")], ended: true, finish: false };
  }
  switch (state.step) {
    case "applicant":
      return momentTwo(state);
    case "leak": {
      if (YES.test(text)) return momentThree(state, DEMO_COPY.approved);
      if (NO.test(text)) return momentThree(state, DEMO_COPY.held);
      if (state.strikes >= 1) return momentThree(state, DEMO_COPY.held);
      return stay(state, [bubble("agent", DEMO_COPY.m2Retry, "leak")], { strikes: state.strikes + 1 });
    }
    case "rent":
      return nextQuestion(state);
    case "ask_address": {
      if (SKIP.test(text)) return finishDemo(state);
      const volunteered = extractHouseHints(text);
      const address = volunteered.address ?? (/\d/.test(text) && text.length >= 5 && text.length <= 80 ? text.replace(/\s+/g, " ") : null);
      if (!address) {
        if (state.strikes >= 1) return finishDemo(state);
        return stay(state, [bubble("agent", DEMO_COPY.askAddressRetry, "ask_address")], { strikes: state.strikes + 1 });
      }
      return nextQuestion({ ...state, hints: mergeHints(state.hints, { ...volunteered, address }) });
    }
    case "ask_rooms": {
      if (SKIP.test(text)) return finishDemo(state);
      const rooms = parseCount(text.replace(/[.!]+$/, "")) ?? extractRoomCount(text);
      if (!rooms) {
        if (state.strikes >= 1) return finishDemo(state);
        return stay(state, [bubble("agent", DEMO_COPY.askRoomsRetry, "ask_rooms")], { strikes: state.strikes + 1 });
      }
      return nextQuestion({ ...state, hints: mergeHints(state.hints, { rooms, ...(extractRent(text) ? { rent: extractRent(text)! } : {}) }) });
    }
    case "ask_rent": {
      if (SKIP.test(text)) return finishDemo(state);
      const bare = /^\$?\s?(\d{3,5})\s*$/.exec(text);
      const rent = extractRent(text) ?? (bare ? Number(bare[1]) : null);
      if (!rent || rent < 200 || rent > 20000) {
        if (state.strikes >= 1) return finishDemo(state);
        return stay(state, [bubble("agent", DEMO_COPY.askRentRetry, "ask_rent")], { strikes: state.strikes + 1 });
      }
      return nextQuestion({ ...state, hints: mergeHints(state.hints, { rent }) });
    }
    case "finished":
      return stay(state, [bubble("agent", DEMO_COPY.finishAgain, "finished")]);
    case "ended":
      return stay(state, [bubble("agent", DEMO_COPY.ended, "ended")]);
  }
}

/** The prompt for the step the user is on (a web chat reopened mid-demo). */
export function currentPrompt(state: DemoState): DemoBubble[] {
  switch (state.step) {
    case "applicant":
      return [bubble("agent", DEMO_COPY.m1End, "applicant")];
    case "leak":
      return [bubble("sample", DEMO_COPY.m2Sample, "leak"), bubble("agent", DEMO_COPY.m2End, "leak")];
    case "rent":
      return [bubble("agent", DEMO_COPY.m3End, "rent")];
    case "ask_address":
      return [bubble("agent", DEMO_COPY.askAddress, "ask_address")];
    case "ask_rooms":
      return [bubble("agent", DEMO_COPY.askRooms, "ask_rooms")];
    case "ask_rent":
      return [bubble("agent", DEMO_COPY.askRent, "ask_rent")];
    case "finished":
      return [bubble("agent", DEMO_COPY.finishAgain, "finished")];
    case "ended":
      return [bubble("agent", DEMO_COPY.ended, "ended")];
  }
}

export function suggestionsFor(step: DemoStep): string[] {
  switch (step) {
    case "applicant":
    case "rent":
      return ["NEXT"];
    case "leak":
      return ["Y", "N"];
    case "ask_address":
    case "ask_rooms":
    case "ask_rent":
      return ["SKIP"];
    case "finished":
    case "ended":
      return ["DEMO"];
  }
}

/** Texting DEMO (whole body) or the homepage prefill starts the demo. */
export function isDemoStartText(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return t === "demo" || /^(hi |hello |hey )?(proplane )?(please )?show me the demo$/.test(t) || t === "try the demo" || t === "start demo" || t === "start the demo";
}

/** The SMS rendering of a bubble: a sample text is labelled so it is not mistaken for PropLane talking to you. */
export function bubbleToSms(b: DemoBubble): string {
  return b.kind === "sample" ? `Sample text to you: ${b.text}` : b.text;
}

