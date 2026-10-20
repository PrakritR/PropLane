/**
 * The homepage Software demo as ONE continuous journey, data only. The embed (`home-demo-embed.tsx`) plays the
 * steps against the REAL portals over fixture data and loops it: `click` steps move the cursor to a real control
 * and press it; `say` steps put the next lines on a phone; `effect` steps (and the `effect` riding on a click or a
 * portal switch) are the INBOUND events written through the same store writers the app uses
 * (`home-demo-effects.ts`); `portal` steps switch which real portal is on screen (the same shell and stores, so
 * what one portal wrote is there when the next opens); `stage` steps move the resident's lifecycle stage, so the
 * resident sidebar unlocks the way the real product does. The parent page imports only this file's data (no
 * stores), to draw the end frame for reduced motion.
 *
 * It follows one renter, Jordan: a text finds a house and books a tour (Resident, Manager), the application is
 * submitted and approved, the first payments are made, the lease is sent and signed (the resident's Lease and My
 * home unlock), and a leaking faucet goes from Jordan's text to the vendor's YES to the manager's Assigned tab.
 * A tab or panel is never shown empty: the effect that fills it lands at the press that opens it.
 */
import { DISCOVERY_LINES, type DiscoveryLine } from "@/components/marketing/home-discovery-script";
import type { HomeDemoPhone, HomeDemoPhoneItem, HomeDemoPortal } from "@/lib/demo/home-demo-embed";
import type { ResidentPortalNavStage } from "@/lib/resident-portal-nav";

/** A real control the cursor goes to. Resolved against the live DOM, so it follows the portal as it changes. */
export type HomeDemoTarget =
  /** A sidebar (or any visible) link into a section of the CURRENT portal, by its route segment. */
  | { kind: "nav"; section: string }
  /** A tab (`role="tab"`, or a button in a tab `nav`) whose text starts with `label`. */
  | { kind: "tab"; label: string }
  /** A list row (`…-list-row`) whose text contains `text`. */
  | { kind: "row"; text: string }
  /** A button by its accessible name, e.g. the calendar's "Next week". */
  | { kind: "button"; label: string }
  /** A button or link whose text contains `text`. */
  | { kind: "text"; text: string }
  /** The first visible element matching a selector (the last resort; prefer the kinds above). */
  | { kind: "css"; selector: string };

export type HomeDemoEffect =
  /** The prospect's text thread, as many lines in as `lines` (both inboxes). */
  | { id: "thread"; lines: number }
  /** The tour is booked: on the manager's calendar and Tours, and the prospect's Tour page. */
  | { id: "tour" }
  | { id: "applicationSubmit" }
  | { id: "applicationApprove" }
  | { id: "chargesCreate" }
  | { id: "chargesPay" }
  | { id: "leaseSend" }
  | { id: "leaseSign" }
  /** The renter's text opens the faucet service (with the photo). */
  | { id: "serviceRequest" }
  /** The service is offered to Pacific Plumbing, so it is on the vendor's Open tab. */
  | { id: "offer" }
  /** The vendor's YES: the service is theirs. */
  | { id: "assign" };

export type HomeDemoStep =
  | { do: "wait"; ms: number }
  /** Reveal the next `count` items of phone `phone` (typing first), then run `effect`. */
  | { do: "say"; count?: number; phone?: number; effect?: HomeDemoEffect; typing?: "in" | "out" }
  | { do: "click"; target: HomeDemoTarget; effect?: HomeDemoEffect }
  /** Move the cursor onto a real control without pressing it (scrolls it into view). */
  | { do: "hover"; target: HomeDemoTarget }
  | { do: "effect"; effect: HomeDemoEffect }
  /** Switch which real portal is on screen (same stores), landing on `section` (and its `tab`) with `effect` already written. */
  | { do: "portal"; role: HomeDemoPortal; section: string; tab?: string; effect?: HomeDemoEffect }
  /** Move the resident's lifecycle stage: what the resident sidebar unlocks. */
  | { do: "stage"; stage: ResidentPortalNavStage }
  /** A named beat of the journey (a no-op; `?skipto=<id>` plays everything before it instantly, for review). */
  | { do: "mark"; id: string };

/** The signed-in resident the resident portal belongs to: their name, email and where they are in the lifecycle. */
export type HomeDemoResident = { name: string; email: string; stage: ResidentPortalNavStage };

/** A phone in the script: `initial` of its items are already on it when the journey starts. */
export type HomeDemoScriptPhone = HomeDemoPhone & { initial?: number };

export type HomeDemoJourney = {
  /** The real portal the journey opens in, and the section it opens on. */
  portal: HomeDemoPortal;
  section: string;
  resident: HomeDemoResident;
  phones: HomeDemoScriptPhone[];
  steps: HomeDemoStep[];
};

/* ───────────── Sample photos: drawn, never stock, never a listing photo ───────────── */

/** Base64, because the service record only renders an inline image whose data URL is `data:image/…;base64,…`. */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const FAUCET =
  '<path d="M150 210V150a46 46 0 0 1 46-46h72a22 22 0 0 1 22 22v18h-34v-6h-52a12 12 0 0 0-12 12v56z" fill="#9aa5b1" stroke="#5f6b7a" stroke-width="5" stroke-linejoin="round"/>' +
  '<rect x="128" y="206" width="48" height="14" rx="5" fill="#7b8794" stroke="#5f6b7a" stroke-width="4"/>' +
  '<path d="M290 144h-34v22a6 6 0 0 0 6 6h22a6 6 0 0 0 6-6z" fill="#7b8794" stroke="#5f6b7a" stroke-width="4" stroke-linejoin="round"/>';

/** The two sample illustrations the demo texts around: a leaking faucet, then the same faucet fixed. */
export const HOME_DEMO_PHOTOS = {
  leak: svgDataUrl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e8edf2"/><rect y="236" width="400" height="64" fill="#cfd6de"/><rect x="60" y="226" width="280" height="14" rx="4" fill="#b8c1cb"/>' +
      FAUCET +
      '<g fill="#3b82f6"><path d="M273 180c-7 12-10 18-10 24a10 10 0 0 0 20 0c0-6-3-12-10-24z"/><path d="M273 214c-5 8-7 12-7 16a7 7 0 0 0 14 0c0-4-2-8-7-16z" opacity=".7"/></g><ellipse cx="273" cy="238" rx="26" ry="6" fill="#3b82f6" opacity=".35"/></svg>',
  ),
  fixed: svgDataUrl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e8edf2"/><rect y="236" width="400" height="64" fill="#cfd6de"/><rect x="60" y="226" width="280" height="14" rx="4" fill="#b8c1cb"/>' +
      FAUCET +
      '<circle cx="332" cy="68" r="26" fill="#22a06b"/><path d="M319 68l9 9 17-18" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ),
} as const;

/** `DISCOVERY_LINES` as phone items: the divider and the tour card keep their own shapes. */
function discoveryItems(lines: readonly DiscoveryLine[]): HomeDemoPhoneItem[] {
  return lines.map((line): HomeDemoPhoneItem => {
    switch (line.kind) {
      case "prospect":
        return { kind: "out", text: line.text };
      case "proplane":
        return { kind: "in", text: line.text };
      case "listings":
        return { kind: "listings", ids: line.listings.map((l) => l.id) };
      case "tour":
        return { kind: "tour", street: line.street, dayLabel: line.dayLabel, timeLabel: line.timeLabel };
      case "divider":
        return { kind: "divider", text: line.text };
    }
  });
}

/* ───────────── The journey ───────────── */

/**
 * The resident's phone (Jordan): the shared discovery conversation up to the booked tour, then the texts the rest of
 * the journey adds. A caption names the role, never the person (captain #30).
 */
const RESIDENT_PHONE: HomeDemoScriptPhone = {
  label: "Resident’s phone",
  initial: 1,
  items: [
    ...discoveryItems(DISCOVERY_LINES.slice(0, 6)),
    { kind: "in", text: "Your application for 61 Willow Court is approved." },
    { kind: "in", text: "Your lease is ready. Sign it in your portal." },
    { kind: "out", text: "The kitchen faucet is leaking." },
    { kind: "photo", from: "out", art: "leak" },
    { kind: "in", text: "Thanks. I opened a service for 61 Willow Court and attached your photo." },
  ],
};

const VENDOR_PHONE: HomeDemoScriptPhone = {
  label: "Vendor’s phone",
  items: [
    { kind: "in", text: "New service at 61 Willow Court: leaking kitchen faucet. Reply YES to take it." },
    { kind: "out", text: "YES" },
    { kind: "in", text: "It’s yours. We’ll send you the details." },
  ],
};

export const HOME_DEMO_JOURNEY: HomeDemoJourney = {
  // Jordan, a prospect who has not applied: the resident portal opens on the conversation that is already under way.
  portal: "resident",
  section: "communication",
  resident: { name: "Jordan Ellis", email: "jordan.prospect@example.com", stage: "pre_approval" },
  phones: [RESIDENT_PHONE, VENDOR_PHONE],
  steps: [
    /* a. A text books a tour: it shows on the resident's Tour and on the manager's Tours. */
    { do: "mark", id: "tour" },
    { do: "wait", ms: 1000 },
    { do: "say", count: 3, typing: "in", effect: { id: "thread", lines: 4 } },
    { do: "say", count: 1, typing: "out", effect: { id: "thread", lines: 5 } },
    { do: "say", count: 1, typing: "in", effect: { id: "thread", lines: 6 } },
    { do: "wait", ms: 700 },
    { do: "click", target: { kind: "nav", section: "tour" }, effect: { id: "tour" } },
    { do: "wait", ms: 1900 },
    { do: "portal", role: "manager", section: "tours", tab: "upcoming" },
    { do: "wait", ms: 2200 },
    /* b. The application: the resident submits, the manager approves. */
    { do: "mark", id: "application" },
    { do: "stage", stage: "application_submitted" },
    { do: "portal", role: "resident", section: "applications", effect: { id: "applicationSubmit" } },
    { do: "wait", ms: 2000 },
    { do: "portal", role: "manager", section: "applications" },
    { do: "wait", ms: 1400 },
    { do: "click", target: { kind: "tab", label: "Approved" }, effect: { id: "applicationApprove" } },
    { do: "say", count: 1, typing: "in" },
    { do: "wait", ms: 1700 },
    /* c. The first payments: the resident pays, the manager sees them under Incoming payments. */
    { do: "mark", id: "payments" },
    { do: "stage", stage: "post_approval_pre_lease" },
    { do: "portal", role: "resident", section: "payments", effect: { id: "chargesCreate" } },
    { do: "wait", ms: 1800 },
    { do: "click", target: { kind: "tab", label: "Paid" }, effect: { id: "chargesPay" } },
    { do: "wait", ms: 1800 },
    { do: "portal", role: "manager", section: "payments", tab: "paid" },
    { do: "wait", ms: 2400 },
    /* d. The lease: the manager sends it, the resident signs, Lease and My home unlock. */
    { do: "mark", id: "lease" },
    { do: "portal", role: "manager", section: "leases", tab: "resident", effect: { id: "leaseSend" } },
    { do: "say", count: 1, typing: "in" },
    { do: "wait", ms: 2200 },
    { do: "portal", role: "resident", section: "lease" },
    { do: "wait", ms: 1600 },
    { do: "click", target: { kind: "tab", label: "Signed" }, effect: { id: "leaseSign" } },
    { do: "wait", ms: 1200 },
    { do: "stage", stage: "post_lease" },
    { do: "wait", ms: 2200 },
    /* e. The vendor moment: Jordan's text opens a service, the vendor takes it, the manager sees it Assigned. */
    { do: "mark", id: "vendor" },
    { do: "say", count: 2, typing: "out" },
    { do: "say", count: 1, typing: "in" },
    { do: "wait", ms: 500 },
    { do: "click", target: { kind: "nav", section: "services" }, effect: { id: "serviceRequest" } },
    { do: "wait", ms: 1900 },
    { do: "say", phone: 1, count: 1, typing: "in", effect: { id: "offer" } },
    { do: "portal", role: "vendor", section: "work-orders" },
    { do: "wait", ms: 2000 },
    { do: "say", phone: 1, count: 1, typing: "out" },
    { do: "click", target: { kind: "tab", label: "Assigned" }, effect: { id: "assign" } },
    { do: "wait", ms: 1700 },
    { do: "say", phone: 1, count: 1, typing: "in" },
    { do: "wait", ms: 600 },
    { do: "portal", role: "manager", section: "services" },
    { do: "wait", ms: 3200 },
  ],
};

/** The portal on screen once the journey has run (the last `portal` step's role), for the reduced-motion end frame. */
export function homeDemoEndPortal(): HomeDemoPortal {
  let role = HOME_DEMO_JOURNEY.portal;
  for (const step of HOME_DEMO_JOURNEY.steps) if (step.do === "portal") role = step.role;
  return role;
}

/** The portal and phone on screen at the journey's first frame (what a visitor who gets motion sees first). */
export function homeDemoStartPortal(): HomeDemoPortal {
  return HOME_DEMO_JOURNEY.portal;
}

export function homeDemoStartPhone(): HomeDemoPhone {
  const phone = HOME_DEMO_JOURNEY.phones[0]!;
  return { label: phone.label, items: phone.items.slice(0, phone.initial ?? 0) };
}

/** The phone on screen after the first `count` steps have run (default: all of them, the journey's end). */
export function homeDemoPhoneAfter(count: number = HOME_DEMO_JOURNEY.steps.length): HomeDemoPhone {
  let index = 0;
  const shown = HOME_DEMO_JOURNEY.phones.map((phone) => phone.initial ?? 0);
  for (const step of HOME_DEMO_JOURNEY.steps.slice(0, count)) {
    if (step.do !== "say") continue;
    index = step.phone ?? index;
    shown[index] = Math.min(HOME_DEMO_JOURNEY.phones[index]!.items.length, shown[index]! + (step.count ?? 1));
  }
  const phone = HOME_DEMO_JOURNEY.phones[index]!;
  return { label: phone.label, items: phone.items.slice(0, shown[index]) };
}

/** The phone on screen once the journey has run: the last one it spoke on, with everything it showed. */
export function homeDemoEndPhone(): HomeDemoPhone {
  return homeDemoPhoneAfter();
}

/**
 * Where the portal switcher takes the visitor, as step indexes of the journey. `resumeAt` is the portal's FIRST
 * step (the `portal` step that opens it; 0 for the portal the journey opens in): everything before it has been
 * written to the stores by then, so what it opens is never empty. `until` is where that portal's last stretch ends
 * (the next `portal` step into another portal, or the journey's end): reduced motion draws that frame.
 */
export type HomeDemoJumpPlan = { resumeAt: number; until: number };

export function homeDemoJumpPlan(role: HomeDemoPortal): HomeDemoJumpPlan {
  const steps = HOME_DEMO_JOURNEY.steps;
  const switches = steps.flatMap((step, index) => (step.do === "portal" ? [{ index, role: step.role }] : []));
  const first = role === HOME_DEMO_JOURNEY.portal ? 0 : (switches.find((s) => s.role === role)?.index ?? 0);
  // The last stretch in this portal: from its final entry (or the journey's start) to the next switch elsewhere.
  const lastEntry = [...switches].reverse().find((s) => s.role === role);
  const from = lastEntry?.index ?? 0;
  const leave = switches.find((s) => s.index > from && s.role !== role);
  let until = leave ? leave.index : steps.length;
  // A text that only announces the next portal's work (the offer to the vendor) belongs to that portal's part.
  for (let step = steps[until - 1]; until > from + 1 && step?.do === "say" && step.phone !== undefined && step.effect !== undefined; step = steps[until - 1]) until -= 1;
  return { resumeAt: first, until };
}
