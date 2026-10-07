/**
 * The home page demo's script: what each portal plays, in which order, and
 * the sample state at every beat. Pure data and pure functions (no React) so
 * the engine in `resident-lifecycle-prototypes.tsx` can derive everything from
 * one number, the beat, and a stage tab can jump anywhere without replaying.
 *
 * Manager steps are Akhil's guided sample (message, tour, application, lease,
 * home), kept verbatim; the Rent and Repair stages and the resident and vendor
 * portals were added on top. Nothing here is written anywhere: it is sample
 * data for a static marketing page.
 */

import type { DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";

export type Chapter = "message" | "tour" | "application" | "lease" | "home";
export type SampleMessage = { from: "manager" | "resident"; text: string; stage: Chapter };

export const PORTAL_ORDER: DemoPortal[] = ["manager", "resident", "vendor"];

export const PORTAL_META: Record<
  DemoPortal,
  {
    label: string;
    product: string;
    workspace: string;
    profile: { name: string; email: string; initials: string };
    workspaceLabel: string;
    phoneCaption: string;
    opening: string;
  }
> = {
  manager: {
    label: "Manager portal",
    product: "Property",
    workspace: "Seattle Homes",
    profile: { name: "Avery Morgan", email: "avery@seattlehomes.example", initials: "AM" },
    workspaceLabel: "Manager workspace",
    phoneCaption: "Jordan’s phone",
    opening: "Jordan asks about Room 3",
  },
  // The demo window draws "Ask PropLane" for every portal (captain 2026-10-07), though the REAL
  // resident portal mounts no assistant (AGENTS.md, AI Agent & Tool Layer); the real one is unchanged.
  resident: {
    label: "Resident portal",
    product: "Resident",
    workspace: "Seattle Homes",
    profile: { name: "Jordan Rivera", email: "jordan.rivera@example.com", initials: "JR" },
    workspaceLabel: "Resident portal",
    phoneCaption: "Jordan’s phone",
    opening: "Jordan applies for Room 3",
  },
  vendor: {
    label: "Vendor portal",
    product: "Vendor",
    workspace: "Pacific Plumbing",
    profile: { name: "Marcus Lee", email: "marcus@pacificplumbing.example", initials: "ML" },
    workspaceLabel: "Vendor portal",
    phoneCaption: "Marcus’s phone",
    opening: "A service offer arrives",
  },
};

/** The manager's Communication list: Jordan's thread and one other prospect, both at homes in the portfolio. */
export const COMMUNICATION_THREADS = ["Jordan Rivera", "Mina Chen"] as const;

export const SUGGESTED_REPLY =
  "Yes, Room 3 is available. Thursday at 5:30 PM Pacific is offered for a tour. Reply YES to confirm that time.";
export const SERVICE_RECORD = { title: "Kitchen faucet", details: "The water is collecting under the cabinet." };

export type GuideStep = { chapter: Chapter; target: string; instruction: string; activity: [string, string] };

/** Akhil's nine guided steps, in order. Index = beat index in the manager track. */
export const MANAGER_STEPS: GuideStep[] = [
  { chapter: "message", target: "suggest", instruction: "Prepare a reply", activity: ["Checking listing availability", "Reply ready for review"] },
  { chapter: "message", target: "send", instruction: "Send the reply", activity: ["Sending approved reply", "Tour time offered"] },
  { chapter: "tour", target: "accept-tour", instruction: "Jordan confirms this time", activity: ["Checking offered time", "Tour confirmed"] },
  { chapter: "application", target: "approve", instruction: "Approve Jordan’s application", activity: ["Manager approval recorded", "Lease ready for review"] },
  { chapter: "lease", target: "send-lease", instruction: "Send the lease", activity: ["Preparing signature handoff", "Resident review requested"] },
  { chapter: "lease", target: "open-lease", instruction: "Open Jordan’s lease", activity: ["Opening resident portal", "Lease ready to review"] },
  { chapter: "lease", target: "resident-sign", instruction: "Jordan signs after review", activity: ["Resident signature recorded", "Manager signature requested"] },
  { chapter: "lease", target: "manager-sign", instruction: "Countersign the lease", activity: ["Manager signature recorded", "Signed lease available"] },
  { chapter: "home", target: "service", instruction: "Send a service request", activity: ["Request submitted", "Manager service queue updated"] },
];

export type Beat = {
  /** Index into the track's stages. */
  stage: number;
  /** The sidebar tab this beat shows (DEMO_TABS id). */
  tab: string;
  /** One line for the guide strip when the beat has no guided step. */
  caption: string;
  step?: GuideStep;
};
export type StageDef = { id: string; label: string; first: number; count: number };
export type Track = { stages: StageDef[]; beats: Beat[] };

type StageInput = { id: string; label: string; beats: Omit<Beat, "stage">[] };

function buildTrack(inputs: StageInput[]): Track {
  const stages: StageDef[] = [];
  const beats: Beat[] = [];
  inputs.forEach((input, stage) => {
    stages.push({ id: input.id, label: input.label, first: beats.length, count: input.beats.length });
    for (const beat of input.beats) beats.push({ ...beat, stage });
  });
  return { stages, beats };
}

const stepBeat = (tab: string, index: number): Omit<Beat, "stage"> => ({
  tab,
  step: MANAGER_STEPS[index]!,
  caption: MANAGER_STEPS[index]!.instruction,
});

/** First beat after the last guided step: Akhil's "request reached the manager" end state. */
export const MANAGER_DONE_BEAT = MANAGER_STEPS.length;
export const MANAGER_DONE_CAPTION = "Jordan’s request reached the manager";

export const TRACKS: Record<DemoPortal, Track> = {
  manager: buildTrack([
    { id: "message", label: "Message", beats: [stepBeat("communication", 0), stepBeat("communication", 1)] },
    { id: "tour", label: "Tour", beats: [stepBeat("tours", 2)] },
    { id: "application", label: "Application", beats: [stepBeat("applications", 3)] },
    {
      id: "lease",
      label: "Lease",
      beats: [stepBeat("leases", 4), stepBeat("leases", 5), stepBeat("leases", 6), stepBeat("leases", 7)],
    },
    {
      id: "move-in",
      label: "Move in",
      beats: [stepBeat("residents", 8), { tab: "services", caption: MANAGER_DONE_CAPTION }],
    },
    { id: "rent", label: "Rent", beats: [{ tab: "payments", caption: "Rent comes in through Payments" }] },
    { id: "repair", label: "Repair", beats: [{ tab: "services", caption: "Send the service to a vendor" }] },
  ]),
  resident: buildTrack([
    { id: "apply", label: "Apply", beats: [{ tab: "applications", caption: "Jordan applies for Room 3" }] },
    { id: "sign", label: "Sign", beats: [{ tab: "lease", caption: "Jordan signs the lease" }] },
    { id: "pay", label: "Pay", beats: [{ tab: "payments", caption: "Jordan pays rent in the portal" }] },
    { id: "request", label: "Request", beats: [{ tab: "services", caption: "Jordan asks for a repair" }] },
    { id: "forms", label: "Forms", beats: [{ tab: "forms", caption: "Jordan completes a move-in form" }] },
  ]),
  vendor: buildTrack([
    { id: "offer", label: "Offer", beats: [{ tab: "services", caption: "A vendor gets a service offer" }] },
    { id: "quote", label: "Quote", beats: [{ tab: "services", caption: "The vendor sends a quote" }] },
    { id: "visit", label: "Visit", beats: [{ tab: "calendar", caption: "The visit goes on the calendar" }] },
    { id: "paid", label: "Paid", beats: [{ tab: "payments", caption: "The vendor gets paid" }] },
  ]),
};

export function beatTab(portal: DemoPortal, beat: number): string {
  const beats = TRACKS[portal].beats;
  return beats[Math.min(Math.max(beat, 0), beats.length - 1)]!.tab;
}

export function firstBeatOfChapter(chapter: Chapter): number {
  const index = MANAGER_STEPS.findIndex((step) => step.chapter === chapter);
  return index < 0 ? 0 : index;
}

/**
 * The manager sample at a given beat. `statePhase` is the number of guided
 * steps whose effect is visible (an action shows its effect the moment it is
 * taken, before the chapter changes); `beat` decides the chapter and tab.
 */
export function managerScript(beat: number, statePhase: number, sentReply: string) {
  const phase = Math.min(statePhase, MANAGER_STEPS.length);
  const chapter: Chapter = MANAGER_STEPS[Math.min(beat, MANAGER_STEPS.length)]?.chapter ?? "home";
  const messages: SampleMessage[] = [
    { from: "resident", text: "Is room 3 at 61 Willow Court still available?", stage: "message" },
  ];
  if (phase >= 2) messages.push({ from: "manager", text: sentReply, stage: "message" });
  if (phase >= 3) {
    messages.push(
      { from: "resident", text: "YES - Thursday at 5:30 PM works for me.", stage: "tour" },
      { from: "manager", text: "Your tour is confirmed for Thursday at 5:30 PM.", stage: "tour" },
    );
  }
  const rent = TRACKS.manager.stages.findIndex((stage) => stage.id === "rent");
  const repair = TRACKS.manager.stages.findIndex((stage) => stage.id === "repair");
  const stageIndex = TRACKS.manager.beats[Math.min(beat, TRACKS.manager.beats.length - 1)]!.stage;
  if (stageIndex >= rent) {
    messages.push({ from: "manager", text: "Thanks, Jordan. Your October rent of $1,080 is paid.", stage: "home" });
  }
  if (stageIndex >= repair) {
    messages.push({ from: "manager", text: "A vendor is booked to look at the kitchen faucet on Thursday.", stage: "home" });
  }
  return {
    chapter,
    messages,
    suggestedReply: phase >= 1,
    tourOffered: phase >= 2,
    tourAccepted: phase >= 3,
    applicationSubmitted: phase >= 3,
    applicationApproved: phase >= 4,
    rentPaid: stageIndex >= rent,
    vendorBooked: stageIndex >= repair,
    leaseStep: (phase >= 8 ? 3 : phase >= 7 ? 2 : phase >= 5 ? 1 : 0) as 0 | 1 | 2 | 3,
    serviceRecord: phase >= 9 ? SERVICE_RECORD : null,
  };
}

/* ───────────── The phone beside the resident and vendor portals ───────────── */

export type PhoneIcon = "file" | "calendar" | "wrench" | "card";
export type PhoneItem =
  | { kind: "time"; text: string }
  | { kind: "in" | "out"; text: string }
  | { kind: "card"; icon: PhoneIcon; eyebrow: string; title: string; sub: string };
export type PhoneScript = {
  caption: string;
  initials: string;
  name: string;
  sub: string;
  items: PhoneItem[];
};

const JORDAN_PHONE = { caption: "Jordan’s phone", initials: "AM", name: "Avery Morgan", sub: "Seattle Homes" };
const VENDOR_PHONE = { caption: "Marcus’s phone", initials: "PL", name: "PropLane", sub: "Service offers" };

/** Resident stage id -> what Jordan's phone shows (the manager's side of the thread). */
const RESIDENT_PHONE: Record<string, PhoneItem[]> = {
  apply: [
    { kind: "time", text: "Application" },
    { kind: "in", text: "Your application for Room 3 at 61 Willow Court is in review." },
    { kind: "card", icon: "file", eyebrow: "61 WILLOW COURT · ROOM 3", title: "Rental application", sub: "Submitted · In review" },
  ],
  sign: [
    { kind: "time", text: "Lease" },
    { kind: "in", text: "Your lease is ready to review in your resident portal." },
    { kind: "card", icon: "file", eyebrow: "RESIDENT PORTAL · 61 WILLOW COURT", title: "Residential lease", sub: "Resident signature pending" },
    { kind: "out", text: "Signed, thanks!" },
    { kind: "in", text: "Your signature is recorded. Avery’s signature is next." },
  ],
  pay: [
    { kind: "time", text: "Rent" },
    { kind: "in", text: "October rent of $1,080 is due Oct 1." },
    { kind: "card", icon: "card", eyebrow: "PAYMENTS · ROOM 3", title: "October rent", sub: "$1,080 · Due Oct 1" },
    { kind: "out", text: "Paid, thanks!" },
  ],
  request: [
    { kind: "time", text: "Services" },
    { kind: "out", text: "The kitchen faucet is dripping. Water is collecting under the cabinet." },
    { kind: "in", text: "Your kitchen faucet service request is in the manager’s queue." },
    { kind: "card", icon: "wrench", eyebrow: "SERVICES · ROOM 3", title: "Kitchen faucet", sub: "Open" },
  ],
  forms: [
    { kind: "time", text: "Forms" },
    { kind: "in", text: "Avery sent you a move-in form to complete." },
    { kind: "card", icon: "file", eyebrow: "FORMS · 61 WILLOW COURT", title: "Move-in details", sub: "Waiting for you" },
  ],
};

/** Vendor stage id -> the job offer thread. Offers show the general area only until a bid is accepted. */
const VENDOR_PHONE_ITEMS: Record<string, PhoneItem[]> = {
  offer: [
    { kind: "time", text: "New service offer" },
    { kind: "in", text: "New service in Wallingford, Seattle: kitchen faucet leak. Reply with your quote and when you can come." },
  ],
  quote: [
    { kind: "time", text: "New service offer" },
    { kind: "in", text: "New service in Wallingford, Seattle: kitchen faucet leak. Reply with your quote and when you can come." },
    { kind: "out", text: "I can come Thursday at 9:00 AM. $180." },
    { kind: "in", text: "Quote received. Avery will confirm." },
  ],
  visit: [
    { kind: "time", text: "Quote accepted" },
    { kind: "in", text: "Avery accepted your $180 quote. The address is now in your portal." },
    { kind: "card", icon: "calendar", eyebrow: "SERVICE · 61 WILLOW COURT", title: "Thursday, 9:00 AM", sub: "Kitchen faucet" },
  ],
  paid: [
    { kind: "time", text: "Payment" },
    { kind: "in", text: "Your payment for the kitchen faucet service was sent." },
    { kind: "card", icon: "card", eyebrow: "PAYMENTS · KITCHEN FAUCET", title: "$180", sub: "Paid" },
  ],
};

export function phoneScriptFor(portal: Exclude<DemoPortal, "manager">, stageId: string): PhoneScript {
  return portal === "resident"
    ? { ...JORDAN_PHONE, items: RESIDENT_PHONE[stageId] ?? [] }
    : { ...VENDOR_PHONE, items: VENDOR_PHONE_ITEMS[stageId] ?? [] };
}
