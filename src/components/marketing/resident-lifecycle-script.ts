/**
 * The home page demo's script (captain 2026-10-07): four beats per portal, each beat
 * one or two phone messages and the real panel that matches them. Pure data and pure
 * functions (no React) so the engine in `resident-lifecycle-prototypes.tsx` can derive
 * everything on screen from one number, how many messages the phone has shown.
 *
 * Manager and resident tell the same story, and it is CAUSAL and manager-led (captain
 * 2026-10-07, round 7): every phone line the manager's portal causes follows a visible
 * click in the window. 1 A prospect texts, PropLane drafts a reply, the manager approves
 * it and the tour lands on the phone. 2 The manager sends the application link, the
 * resident applies, the manager approves. 3 The manager sends the lease, the resident
 * signs, the manager countersigns. 4 The manager sends a rent reminder, the resident pays
 * and reports a leak, the manager dispatches Pacific Plumbing (`MANAGER_STEPS`). The vendor
 * portal tells the repair from the other side: offer, quote, visit, paid. People are
 * shown by role ("Manager", "Resident", "Vendor"), never by a sample name; a manager's
 * list rows keep a plain first name where a list needs one. Nothing here is written
 * anywhere: it is sample data for a static marketing page.
 */

import type { DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { NO_STORY, vendorStory, type DemoStory } from "@/components/marketing/site/product-mock/world";

export type SampleMessage = { from: "manager" | "resident"; text: string };

export const PORTAL_ORDER: DemoPortal[] = ["manager", "resident", "vendor"];

export const PORTAL_META: Record<
  DemoPortal,
  {
    label: string;
    product: string;
    workspace: string;
    profile: { name: string; email: string; initials: string };
  }
> = {
  manager: {
    label: "Manager portal",
    product: "Property",
    workspace: "Seattle Homes",
    profile: { name: "Manager", email: "manager@seattlehomes.example", initials: "M" },
  },
  // The demo window draws "Ask PropLane" for every portal (captain 2026-10-07), though the REAL
  // resident portal mounts no assistant (AGENTS.md, AI Agent & Tool Layer); the real one is unchanged.
  resident: {
    label: "Resident portal",
    product: "Resident",
    workspace: "Seattle Homes",
    profile: { name: "Resident", email: "resident@example.com", initials: "R" },
  },
  vendor: {
    label: "Vendor portal",
    product: "Vendor",
    workspace: "Pacific Plumbing",
    profile: { name: "Vendor", email: "vendor@pacificplumbing.example", initials: "V" },
  },
};

/** The manager's Communication list: the prospect's thread and one other prospect, both at homes in the portfolio. */
export const COMMUNICATION_THREADS = ["Jordan", "Mina Chen"] as const;

/* ───────────────────────────── The beats ───────────────────────────── */

export type PhoneIcon = "file" | "calendar" | "wrench" | "card";
export type PhoneCard = { icon: PhoneIcon; eyebrow: string; title: string; sub: string };
export type PhoneItem =
  | { kind: "time"; text: string }
  | { kind: "in" | "out"; text: string }
  | ({ kind: "card" } & PhoneCard);
export type PhoneScript = {
  caption: string;
  initials: string;
  name: string;
  sub: string;
  items: PhoneItem[];
};

/** One message. `out` is sent by the phone's owner (the resident, or the vendor), `in` is the other party's. */
export type StoryMessage = { kind: "in" | "out"; text: string; card?: PhoneCard };
export type StoryBeat = {
  id: string;
  /** The sidebar tab this beat opens (a `DEMO_TABS` id). */
  tab: string;
  /** The small time label above the beat's first message. */
  time: string;
  messages: StoryMessage[];
};

type Journey = Omit<StoryBeat, "tab">[];

/**
 * What the prospect, then resident, says to the manager, and what comes back. Shared by the
 * manager and resident portals. Every `in` line is something the manager caused with a click in
 * the window (`MANAGER_STEPS` puts that click right before it); every `out` line is the
 * resident's own.
 */
const RESIDENT_JOURNEY: Journey = [
  {
    id: "tour",
    time: "Today",
    messages: [
      { kind: "out", text: "Hi! Is Room 3 at 61 Willow Court still available? Could I tour it Thursday?" },
      {
        kind: "in",
        text: "Yes, it is. You're booked for Thursday at 5:30 PM.",
        card: { icon: "calendar", eyebrow: "TOUR · 61 WILLOW COURT", title: "Thursday, 5:30 PM", sub: "Room 3 · Wallingford, Seattle" },
      },
    ],
  },
  {
    id: "apply",
    time: "Application",
    messages: [
      {
        kind: "in",
        text: "Here is the link to apply for Room 3.",
        card: { icon: "file", eyebrow: "61 WILLOW COURT · ROOM 3", title: "Apply for Room 3 — PropLane", sub: "Tap to start your application" },
      },
      { kind: "out", text: "Just submitted my application!" },
    ],
  },
  {
    id: "sign",
    time: "Lease",
    messages: [
      {
        kind: "in",
        text: "You're approved! Your lease is ready to sign.",
        card: { icon: "file", eyebrow: "RESIDENT PORTAL · 61 WILLOW COURT", title: "Sign your lease", sub: "Residential lease · Ready to sign" },
      },
      { kind: "out", text: "Signed, thank you!" },
    ],
  },
  {
    id: "pay",
    time: "Rent and repairs",
    messages: [
      {
        kind: "in",
        text: "A reminder: October rent is due Oct 1.",
        card: { icon: "card", eyebrow: "PAYMENTS · OCTOBER RENT", title: "$1,080.00", sub: "Due Oct 1" },
      },
      { kind: "out", text: "Paid! The kitchen faucet is leaking, too." },
      {
        kind: "in",
        text: "Pacific Plumbing is booked for Thursday at 9:00 AM.",
        card: { icon: "wrench", eyebrow: "SERVICES · ROOM 3", title: "Kitchen faucet", sub: "Scheduled" },
      },
    ],
  },
];

/** The reply PropLane drafts in the manager's Communication thread: the first beat's `in` message. */
export const DRAFT_REPLY = RESIDENT_JOURNEY[0]!.messages[1]!.text;

const withTabs = (tabs: string[]): StoryBeat[] => RESIDENT_JOURNEY.map((beat, index) => ({ ...beat, tab: tabs[index]! }));

/** Offers show the vendor the general area only, never the street, until a quote is accepted. */
const VENDOR_JOURNEY: StoryBeat[] = [
  {
    id: "offer",
    tab: "services",
    time: "New service offer",
    messages: [{ kind: "in", text: "New service in Wallingford, Seattle: kitchen faucet leak. Reply with your quote and when you can come." }],
  },
  {
    id: "quote",
    tab: "services",
    time: "Quote",
    messages: [
      { kind: "out", text: "I can come Thursday at 9:00 AM. $180." },
      { kind: "in", text: "Quote received. The manager will confirm." },
    ],
  },
  {
    id: "visit",
    tab: "calendar",
    time: "Quote accepted",
    messages: [
      {
        kind: "in",
        text: "The manager accepted your $180 quote. The address is now in your portal.",
        card: { icon: "calendar", eyebrow: "SERVICE · 61 WILLOW COURT", title: "Thursday, 9:00 AM", sub: "Kitchen faucet" },
      },
    ],
  },
  {
    id: "paid",
    tab: "payments",
    time: "Payment",
    messages: [
      {
        kind: "in",
        text: "Your payment for the kitchen faucet service was sent.",
        card: { icon: "card", eyebrow: "PAYMENTS · KITCHEN FAUCET", title: "$180", sub: "Paid" },
      },
    ],
  },
];

/** Four beats per portal, in order. */
export const STORIES: Record<DemoPortal, StoryBeat[]> = {
  manager: withTabs(["communication", "applications", "leases", "payments"]),
  resident: withTabs(["communication", "applications", "lease", "payments"]),
  vendor: VENDOR_JOURNEY,
};

/** The phone: whose it is, who its thread is with, and whether the lines are drawn from the other side. */
export const PHONE_META: Record<DemoPortal, { caption: string; initials: string; name: string; sub: string; mirror: boolean }> = {
  manager: { caption: "Resident's phone", initials: "M", name: "Manager", sub: "Seattle Homes", mirror: false },
  resident: { caption: "Manager's phone", initials: "R", name: "Resident", sub: "61 Willow Court · Room 3", mirror: true },
  vendor: { caption: "Vendor's phone", initials: "PL", name: "PropLane", sub: "Service offers", mirror: false },
};

/** One phone message with the beat it belongs to; the engine reveals them one at a time. */
export type StoryFrame = { beat: number; message: StoryMessage; first: boolean };

export function framesFor(portal: DemoPortal): StoryFrame[] {
  return STORIES[portal].flatMap((beat, index) => beat.messages.map((message, at) => ({ beat: index, message, first: at === 0 })));
}

/** The beat a visitor sees after `shown` messages: the beat of the latest message, and the first beat before any. */
export function beatAfter(portal: DemoPortal, shown: number): number {
  const frames = framesFor(portal);
  if (shown <= 0) return 0;
  return frames[Math.min(shown, frames.length) - 1]!.beat;
}

/** How many messages the phone has shown once beat `beat` is done. */
export function shownThrough(portal: DemoPortal, beat: number): number {
  return framesFor(portal).filter((frame) => frame.beat <= beat).length;
}

/** The thread's lines from the phone owner's side, for the first `shown` messages (time labels and cards included). */
export function threadItems(portal: DemoPortal, shown: number): PhoneItem[] {
  const items: PhoneItem[] = [];
  framesFor(portal)
    .slice(0, Math.max(0, shown))
    .forEach((frame) => {
      if (frame.first) items.push({ kind: "time", text: STORIES[portal][frame.beat]!.time });
      items.push({ kind: frame.message.kind, text: frame.message.text });
      if (frame.message.card) items.push({ kind: "card", ...frame.message.card });
    });
  return items;
}

/** The same lines as the other party's phone shows them: what one side sent, the other received. */
export function mirrorItems(items: PhoneItem[]): PhoneItem[] {
  return items.map((item) => (item.kind === "in" ? { kind: "out", text: item.text } : item.kind === "out" ? { kind: "in", text: item.text } : item));
}

/** The manager's Communication thread, drawn from the same messages as the phone. */
export function managerMessages(shown: number): SampleMessage[] {
  return framesFor("manager")
    .slice(0, Math.max(0, shown))
    .map((frame) => ({ from: frame.message.kind === "out" ? "resident" : "manager", text: frame.message.text }));
}

/* ───────────────────────────── The timeline ───────────────────────────── */

/** A message types for TYPE_MS, stays for HOLD_MS, then the next one starts typing; the first waits INTRO_MS. */
export const TYPE_MS = 1500;
export const HOLD_MS = 2300;
export const INTRO_MS = 2800;
export const END_MS = 3200;

export type StepKind =
  /** Nothing moves for `ms`. */
  | "wait"
  /** The next phone message types for `ms`, then lands. */
  | "say"
  /** The cursor goes to a sidebar item (`target` is the tab id) and opens it. */
  | "nav"
  /** The cursor clicks the control marked `data-demo-target="<target>"`. */
  | "click";
export type StepPatch = { story?: Partial<DemoStory>; draft?: boolean };
export type Step = {
  beat: number;
  kind: StepKind;
  /** wait / say: how long it lasts. nav / click: the time it takes when no cursor is drawn. */
  ms: number;
  target?: string;
  /** What the sample state gains once the step is done. */
  patch?: StepPatch;
};

/** The sample state on screen: everything is the fold of the steps that are done. */
export type DemoState = { shown: number; tab: string; story: DemoStory; draft: boolean };

const wait = (beat: number, ms: number, patch?: StepPatch): Step => ({ beat, kind: "wait", ms, patch });
const say = (beat: number, ms: number, patch?: StepPatch): Step => ({ beat, kind: "say", ms, patch });
const nav = (beat: number, tab: string): Step => ({ beat, kind: "nav", ms: 500, target: tab });
const click = (beat: number, target: string, patch?: StepPatch): Step => ({ beat, kind: "click", ms: 600, target, patch });

/**
 * The manager's story, step by step. The phone belongs to the resident, so a `say` of an
 * `out` line is the resident texting or acting, and every `say` of an `in` line sits right
 * after a `click` the manager made in the window. The panels move on their own: a patch
 * changes the sample story and the real panel follows its row to the next tab.
 */
export const MANAGER_STEPS: Step[] = [
  // The Dashboard shows first, before anyone does anything.
  wait(0, INTRO_MS),
  // 1 Tour: the prospect texts, PropLane drafts a reply, the manager approves it.
  nav(0, "communication"),
  say(0, TYPE_MS),
  wait(0, 900, { draft: true }),
  click(0, "comm-approve", { draft: false, story: { tourOffered: true, tourAccepted: true } }),
  say(0, 1000),
  wait(0, HOLD_MS),
  // 2 Application: the manager sends the apply link, the resident applies, the manager approves.
  nav(1, "applications"),
  click(1, "applications-send"),
  click(1, "sheet-primary"),
  say(1, 1000),
  wait(1, 900),
  say(1, TYPE_MS, { story: { applicationSubmitted: true } }),
  wait(1, 1100),
  click(1, "application-row"),
  click(1, "sheet-primary", { story: { applicationApproved: true } }),
  wait(1, HOLD_MS),
  // 3 Lease: the manager sends it, the resident signs, the manager countersigns.
  nav(2, "leases"),
  click(2, "lease-row"),
  click(2, "sheet-primary", { story: { leaseStep: 1 } }),
  say(2, 1000),
  say(2, TYPE_MS, { story: { leaseStep: 2 } }),
  wait(2, 1100),
  click(2, "lease-row"),
  click(2, "sheet-primary", { story: { leaseStep: 3 } }),
  wait(2, HOLD_MS),
  // 4 Rent and repairs: a reminder, the resident pays and reports a leak, the manager dispatches.
  nav(3, "payments"),
  click(3, "payment-row"),
  click(3, "sheet-primary"),
  say(3, 1000),
  say(3, TYPE_MS, { story: { rentPaid: true, service: "open" } }),
  wait(3, 1100),
  nav(3, "services"),
  click(3, "service-row"),
  click(3, "sheet-primary", { story: { service: "scheduled" } }),
  say(3, 1000),
  wait(3, END_MS),
];

/** The resident and vendor windows have no cursor: each message types, lands and holds. */
function phoneSteps(portal: Exclude<DemoPortal, "manager">): Step[] {
  const steps: Step[] = [];
  const beats = STORIES[portal];
  beats.forEach((beat, index) => {
    steps.push({ beat: index, kind: "nav", ms: index === 0 ? INTRO_MS : 400, target: beat.tab });
    beat.messages.forEach((_, at) => {
      steps.push(say(index, TYPE_MS));
      steps.push(wait(index, index === beats.length - 1 && at === beat.messages.length - 1 ? END_MS : HOLD_MS));
    });
  });
  return steps;
}

const PHONE_STEPS = { resident: phoneSteps("resident"), vendor: phoneSteps("vendor") };

/** The steps one portal's demo plays, in order, then starts over. */
export function timelineFor(portal: DemoPortal): Step[] {
  return portal === "manager" ? MANAGER_STEPS : PHONE_STEPS[portal];
}

/** What the window shows before the first step: the manager's Dashboard, else the first beat's tab. */
export function initialState(portal: DemoPortal): DemoState {
  return { shown: 0, tab: portal === "manager" ? "dashboard" : STORIES[portal][0]!.tab, story: NO_STORY, draft: false };
}

function applyStep(state: DemoState, step: Step): DemoState {
  return {
    shown: step.kind === "say" ? state.shown + 1 : state.shown,
    tab: step.kind === "nav" ? step.target! : state.tab,
    story: step.patch?.story ? { ...state.story, ...step.patch.story } : state.story,
    draft: step.patch?.draft ?? state.draft,
  };
}

/** The state once the first `count` steps of a portal's timeline are done. */
export function stateAfter(portal: DemoPortal, count: number): DemoState {
  return timelineFor(portal)
    .slice(0, Math.max(0, count))
    .reduce(applyStep, initialState(portal));
}

/** The state when beat `beat` is done (every step up to its last). */
export function stateAtBeat(portal: DemoPortal, beat: number): DemoState {
  let count = 0;
  timelineFor(portal).forEach((step, index) => {
    if (step.beat <= beat) count = index + 1;
  });
  return stateAfter(portal, count);
}

/** The manager timeline's story once `shown` phone messages have landed: what the resident's own portal knows. */
function storyOnceShown(shown: number): DemoStory {
  let landed = 0;
  let count = 0;
  for (let index = 0; index < MANAGER_STEPS.length && landed < shown; index += 1) {
    if (MANAGER_STEPS[index]!.kind === "say") landed += 1;
    count = index + 1;
  }
  return stateAfter("manager", count).story;
}

/** The sample story the panels draw at a point in the demo (`world.ts` derives every row and count from it). */
export function storyFor(portal: DemoPortal, state: DemoState, beat: number): DemoStory {
  if (portal === "manager") return state.story;
  if (portal === "vendor") return vendorStory(STORIES.vendor[Math.min(Math.max(beat, 0), 3)]!.id);
  return { ...storyOnceShown(state.shown), formSent: beat >= 3 };
}

/** The sample story at the end of a beat (the still the reduced-motion demo shows, and what tests pin). */
export function storyAt(portal: DemoPortal, beat: number): DemoStory {
  return storyFor(portal, stateAtBeat(portal, beat), beat);
}

/**
 * What a portal's thread says through one beat, for the Communication panels (the resident's
 * and the vendor's inbox are this thread). `stageId` is a beat id.
 */
export function phoneScriptFor(portal: Exclude<DemoPortal, "manager">, stageId: string): PhoneScript {
  const beats = STORIES[portal];
  const index = Math.max(0, beats.findIndex((beat) => beat.id === stageId));
  const meta = PHONE_META[portal];
  return {
    caption: meta.caption,
    initials: meta.initials,
    name: meta.name,
    sub: meta.sub,
    items: threadItems(portal, shownThrough(portal, index)),
  };
}
