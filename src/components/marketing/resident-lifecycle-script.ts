/**
 * The home page demo's script (captain 2026-10-07): four beats per portal, each beat
 * one or two phone messages and the real panel that matches them. Pure data and pure
 * functions (no React) so the engine in `resident-lifecycle-prototypes.tsx` can derive
 * everything on screen from one number, how many messages the phone has shown.
 *
 * Manager and resident tell the same story: 1 a prospect asks about Room 3 and books a
 * tour, 2 applies, 3 signs the lease, 4 pays rent and gets a repair booked. The vendor
 * portal tells the repair from the other side: offer, quote, visit, paid. People are
 * shown by role ("Manager", "Resident", "Vendor"), never by a sample name; a manager's
 * list rows keep a plain first name where a list needs one. Nothing here is written
 * anywhere: it is sample data for a static marketing page.
 */

import type { DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { managerStory, residentStory, vendorStory, type DemoStory } from "@/components/marketing/site/product-mock/world";

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

/** What the prospect, then resident, says to the manager, and what comes back. Shared by the manager and resident portals. */
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
      { kind: "out", text: "I just submitted my application for Room 3." },
      {
        kind: "in",
        text: "Got it. Your application is in review.",
        card: { icon: "file", eyebrow: "61 WILLOW COURT · ROOM 3", title: "Rental application", sub: "Submitted · In review" },
      },
    ],
  },
  {
    id: "sign",
    time: "Lease",
    messages: [
      {
        kind: "in",
        text: "You're approved! Your lease is ready to review and sign.",
        card: { icon: "file", eyebrow: "RESIDENT PORTAL · 61 WILLOW COURT", title: "Residential lease", sub: "Ready to sign" },
      },
      { kind: "out", text: "Signed, thank you!" },
    ],
  },
  {
    id: "pay",
    time: "Rent and repairs",
    messages: [
      { kind: "out", text: "October rent is paid. The kitchen faucet is dripping, too." },
      {
        kind: "in",
        text: "Rent received. A plumber is booked for Thursday at 9:00 AM.",
        card: { icon: "wrench", eyebrow: "SERVICES · ROOM 3", title: "Kitchen faucet", sub: "Scheduled" },
      },
    ],
  },
];

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
  manager: withTabs(["tours", "applications", "leases", "payments"]),
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

/** The sample state the panels draw at a beat (`world.ts` derives every row and count from it). */
export function storyAt(portal: DemoPortal, beat: number): DemoStory {
  const id = STORIES[portal][Math.min(Math.max(beat, 0), 3)]!.id;
  if (portal === "resident") return residentStory(id);
  if (portal === "vendor") return vendorStory(id);
  return managerStory({
    tourOffered: true,
    tourAccepted: true,
    applicationSubmitted: beat >= 1,
    applicationApproved: beat >= 2,
    leaseStep: beat >= 2 ? 3 : 0,
    rentPaid: beat >= 3,
    vendorBooked: beat >= 3,
    hasServiceRecord: beat >= 3,
  });
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
