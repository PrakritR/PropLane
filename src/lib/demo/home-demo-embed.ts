/**
 * The contract between the homepage Software demo (parent page) and its iframe
 * (`/demo/home-embed`, the real manager portal over fixture data). Pure constants and types so
 * the middleware, the embed and the parent can all import it.
 */

export const HOME_DEMO_EMBED_PATH = "/demo/home-embed";

/** Embed -> parent: where the journey is, what the phone shows and which portal is on screen. */
export const HOME_DEMO_EVENT = "proplane-home-demo";
/** Embed -> parent: the visitor pressed something inside the portal (the parent pauses). */
export const HOME_DEMO_INTERACT = "proplane-home-demo-interact";
/** Embed -> parent: its message listener is attached. The iframe `load` event fires before hydration, so a
 *  control sent on load can be lost; the parent re-sends play/pause on this. */
export const HOME_DEMO_READY = "proplane-home-demo-ready";
/** Parent -> embed: play / pause. */
export const HOME_DEMO_CONTROL = "proplane-home-demo-control";

/** The three real portals the demo shows. */
export type HomeDemoPortal = "resident" | "vendor" | "manager";

/** What the visitor reads for each portal: the cursor's label and the player's caption. */
export const HOME_DEMO_PORTAL_LABEL: Record<HomeDemoPortal, string> = {
  resident: "Resident",
  vendor: "Vendor",
  manager: "Manager",
};

export function isHomeDemoPortal(value: unknown): value is HomeDemoPortal {
  return value === "resident" || value === "vendor" || value === "manager";
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
  /** Index of the script step that just ran (-1 before the first). */
  step: number;
  /** True once the journey's last step has run (the parent then lets it loop). */
  done: boolean;
  /** Who is typing on the phone right now, if anyone. */
  typing: "in" | "out" | null;
  phone: HomeDemoPhone;
  /** Which real portal is on screen right now. */
  portal: HomeDemoPortal;
};

/** `restart` plays the journey again from its first frame (the parent sends it when a run has finished and held). */
export type HomeDemoControl = { type: typeof HOME_DEMO_CONTROL; action: "play" | "pause" | "restart" };
