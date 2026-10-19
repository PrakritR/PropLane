/**
 * The contract between the homepage Software demo (parent page) and its iframe
 * (`/demo/home-embed`, the real manager portal over fixture data). Pure constants and types so
 * the middleware, the embed and the parent can all import it.
 */

export const HOME_DEMO_EMBED_PATH = "/demo/home-embed";

/** Embed -> parent: where the chapter is and what the phone should show. */
export const HOME_DEMO_EVENT = "proplane-home-demo";
/** Embed -> parent: the visitor pressed something inside the portal (the parent pauses). */
export const HOME_DEMO_INTERACT = "proplane-home-demo-interact";
/** Embed -> parent: its message listener is attached. The iframe `load` event fires before hydration, so a
 *  control sent on load can be lost; the parent re-sends the current chapter and play/pause on this. */
export const HOME_DEMO_READY = "proplane-home-demo-ready";
/** Parent -> embed: play / pause / select a chapter. */
export const HOME_DEMO_CONTROL = "proplane-home-demo-control";

export const HOME_DEMO_CHAPTERS = [
  { id: "find", number: "01", label: "Find a house" },
  { id: "vendor", number: "02", label: "Vendor gets work" },
  { id: "photo", number: "03", label: "Photo by text" },
] as const;
export type HomeDemoChapterId = (typeof HOME_DEMO_CHAPTERS)[number]["id"];

export function isHomeDemoChapterId(value: unknown): value is HomeDemoChapterId {
  return HOME_DEMO_CHAPTERS.some((chapter) => chapter.id === value);
}

/** One thing on the phone. Listings and the tour are the #13 discovery cards; photos are drawn sample SVGs. */
export type HomeDemoPhoneItem =
  | { kind: "in" | "out"; text: string }
  | { kind: "divider"; text: string }
  | { kind: "listings"; ids: readonly string[] }
  | { kind: "tour"; street: string; dayLabel: string; timeLabel: string }
  | { kind: "photo"; from: "in" | "out"; art: "leak" | "fixed"; caption?: string };

export type HomeDemoPhone = {
  /** Whose phone this is, e.g. "Prospect's phone". */
  label: string;
  items: HomeDemoPhoneItem[];
};

export type HomeDemoEvent = {
  type: typeof HOME_DEMO_EVENT;
  chapter: HomeDemoChapterId;
  /** Index of the script step that just ran (-1 before the first). */
  step: number;
  /** True once the chapter's last step has run. */
  done: boolean;
  /** Who is typing on the phone right now, if anyone. */
  typing: "in" | "out" | null;
  phone: HomeDemoPhone;
};

export type HomeDemoControl =
  | { type: typeof HOME_DEMO_CONTROL; action: "play" | "pause" }
  | { type: typeof HOME_DEMO_CONTROL; action: "select"; chapter: HomeDemoChapterId };
