/**
 * The homepage Software demo's three chapters, as data. The embed (`home-demo-embed.tsx`) plays the steps
 * against the REAL manager portal: `click` steps move the cursor to a real control and click it; `say` steps put
 * the next lines on the phone; `effect` steps are the INBOUND events (a text arriving, a vendor's YES, a photo)
 * written through the same store writers the app uses (`home-demo-effects.ts`). The parent page imports only this
 * file's data (no stores), to draw the end frame for reduced motion.
 */
import { DISCOVERY_LINES, type DiscoveryLine } from "@/components/marketing/home-discovery-script";
import type { HomeDemoChapterId, HomeDemoPhone, HomeDemoPhoneItem } from "@/lib/demo/home-demo-embed";

/** A real control the cursor goes to. Resolved against the live DOM, so it follows the portal as it changes. */
export type HomeDemoTarget =
  /** A sidebar (or any visible) link into a manager section, by its route segment. */
  | { kind: "nav"; section: string }
  /** A tab (`role="tab"`, or a button in a tab `nav`) whose text starts with `label`. */
  | { kind: "tab"; label: string }
  /** A list row (`…-list-row`) whose text contains `text`. */
  | { kind: "row"; text: string }
  /** A button by its accessible name, e.g. the calendar's "Next week". */
  | { kind: "button"; label: string }
  /** A button or link whose text contains `text` (an event on the calendar grid). */
  | { kind: "text"; text: string }
  /** The first visible element matching a selector (the last resort; prefer the kinds above). */
  | { kind: "css"; selector: string };

export type HomeDemoEffect =
  | { id: "thread"; lines: number }
  | { id: "tour" }
  | { id: "assign"; workOrder: "vendor" | "photo" }
  | { id: "schedule" }
  | { id: "clearServices" }
  | { id: "photoService" }
  | { id: "complete" };

export type HomeDemoStep =
  | { do: "wait"; ms: number }
  /** Reveal the next `count` items of phone `phone` (typing first), then run `effect`. */
  | { do: "say"; count?: number; phone?: number; effect?: HomeDemoEffect; typing?: "in" | "out" }
  | { do: "click"; target: HomeDemoTarget; effect?: HomeDemoEffect }
  /** Move the cursor onto a real control without pressing it (scrolls it into view). */
  | { do: "hover"; target: HomeDemoTarget }
  | { do: "effect"; effect: HomeDemoEffect };

export type HomeDemoChapter = {
  id: HomeDemoChapterId;
  /** Run once, before the first step, on top of the shared fixture world. */
  prepare?: HomeDemoEffect[];
  phones: HomeDemoPhone[];
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

/* ───────────── Chapter 1: a prospect finds a house by text (the #13 conversation) ───────────── */

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

const FIND: HomeDemoChapter = {
  id: "find",
  // Each phone item is one DISCOVERY_LINES entry (8 of them), so `lines: n` on the manager side is `n` items here.
  phones: [{ label: "Prospect’s phone", items: discoveryItems(DISCOVERY_LINES) }],
  steps: [
    { do: "wait", ms: 1200 },
    { do: "say", count: 1, typing: "out", effect: { id: "thread", lines: 1 } },
    { do: "say", count: 3, typing: "in", effect: { id: "thread", lines: 4 } },
    { do: "wait", ms: 600 },
    { do: "click", target: { kind: "nav", section: "communication" } },
    { do: "wait", ms: 900 },
    { do: "click", target: { kind: "row", text: "Jordan" } },
    { do: "wait", ms: 2200 },
    { do: "say", count: 1, typing: "out", effect: { id: "thread", lines: 5 } },
    { do: "say", count: 1, typing: "in", effect: { id: "thread", lines: 6 } },
    { do: "effect", effect: { id: "tour" } },
    { do: "wait", ms: 1800 },
    { do: "click", target: { kind: "nav", section: "calendar" } },
    { do: "wait", ms: 900 },
    { do: "click", target: { kind: "button", label: "Next week" } },
    { do: "wait", ms: 700 },
    { do: "hover", target: { kind: "text", text: "Tour · 61 Willow Court" } },
    { do: "wait", ms: 1800 },
    { do: "say", count: 2, typing: "in", effect: { id: "thread", lines: 8 } },
    { do: "wait", ms: 2600 },
  ],
};

/* ───────────── Chapter 2: a vendor gets work by text ───────────── */

const VENDOR: HomeDemoChapter = {
  id: "vendor",
  phones: [
    {
      label: "Vendor’s phone",
      items: [
        { kind: "in", text: "New service at 61 Willow Court: leaking kitchen faucet. Reply YES to take it." },
        { kind: "out", text: "YES" },
        { kind: "in", text: "It’s yours. Visit booked for Thursday at 9:00 AM." },
      ],
    },
  ],
  steps: [
    { do: "wait", ms: 1000 },
    { do: "say", count: 1, typing: "in" },
    { do: "click", target: { kind: "nav", section: "services" } },
    { do: "wait", ms: 1500 },
    { do: "say", count: 1, typing: "out", effect: { id: "assign", workOrder: "vendor" } },
    { do: "wait", ms: 700 },
    { do: "click", target: { kind: "tab", label: "Assigned" } },
    { do: "wait", ms: 1800 },
    { do: "say", count: 1, typing: "in", effect: { id: "schedule" } },
    { do: "wait", ms: 700 },
    { do: "click", target: { kind: "tab", label: "Scheduled" } },
    { do: "wait", ms: 3000 },
  ],
};

/* ───────────── Chapter 3: a photo by text becomes a service, and completion photos close it ───────────── */

const PHOTO: HomeDemoChapter = {
  id: "photo",
  prepare: [{ id: "clearServices" }],
  phones: [
    {
      label: "Resident’s phone",
      items: [
        { kind: "out", text: "The kitchen faucet is leaking." },
        { kind: "photo", from: "out", art: "leak" },
        { kind: "in", text: "Thanks. I opened a service for 1412 Maple Ct and attached your photo." },
      ],
    },
    {
      label: "Vendor’s phone",
      items: [
        { kind: "in", text: "New service at 1412 Maple Ct: leaking kitchen faucet. Text photos when it’s done." },
        { kind: "out", text: "Done. New cartridge in." },
        { kind: "photo", from: "out", art: "fixed" },
        { kind: "in", text: "Thanks. Photos added and the service is completed." },
      ],
    },
  ],
  steps: [
    { do: "wait", ms: 1000 },
    { do: "click", target: { kind: "nav", section: "services" } },
    { do: "wait", ms: 900 },
    { do: "say", count: 2, phone: 0, typing: "out" },
    { do: "say", count: 1, phone: 0, typing: "in", effect: { id: "photoService" } },
    { do: "wait", ms: 900 },
    { do: "click", target: { kind: "row", text: "Leaking kitchen faucet" } },
    { do: "wait", ms: 700 },
    { do: "hover", target: { kind: "css", selector: '[data-attr="work-order-photos"] a' } },
    { do: "wait", ms: 1600 },
    { do: "say", count: 1, phone: 1, typing: "in", effect: { id: "assign", workOrder: "photo" } },
    { do: "wait", ms: 900 },
    { do: "say", count: 2, phone: 1, typing: "out" },
    { do: "say", count: 1, phone: 1, typing: "in", effect: { id: "complete" } },
    { do: "wait", ms: 500 },
    { do: "hover", target: { kind: "css", selector: '[data-attr="work-order-photos"] a:last-child' } },
    { do: "wait", ms: 3000 },
  ],
};

export const HOME_DEMO_CHAPTER_DATA: Record<HomeDemoChapterId, HomeDemoChapter> = { find: FIND, vendor: VENDOR, photo: PHOTO };

/** What each phone shows after the whole chapter (the still frame for reduced motion). */
export function homeDemoEndPhone(chapter: HomeDemoChapterId): HomeDemoPhone {
  const data = HOME_DEMO_CHAPTER_DATA[chapter];
  return data.phones[data.phones.length - 1]!;
}
