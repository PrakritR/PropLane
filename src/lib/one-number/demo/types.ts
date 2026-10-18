/**
 * The sandbox DEMO, shared by the SMS door (texting DEMO) and the web chat ("Open the demo").
 * Isomorphic: a client component may import these types. The runner is `run-demo-turn.server.ts`.
 */

export type DemoChannel = "sms" | "web";

/** `agent` = PropLane talking to the demo user. `sample` = a text the landlord WOULD receive (drawn as an inset card on the web). */
export type DemoBubble = { id: string; kind: "agent" | "sample"; text: string };

export type DemoStep =
  | "applicant"
  | "leak"
  | "rent"
  | "ask_address"
  | "ask_rooms"
  | "ask_rent"
  | "finished"
  | "ended";

/** What the demo user has told the agent about their real house. Becomes the DRAFT property after sign-in. */
export type DemoHints = { address?: string; rooms?: number; rent?: number };

export type DemoState = {
  step: DemoStep;
  hints: DemoHints;
  /** Wrong answers at the current step; the second one moves the demo on instead of looping. */
  strikes: number;
};

export type DemoTurnInput = {
  channel: DemoChannel;
  /** SMS: the 10-digit phone key. Web: an opaque browser session id, 16-64 chars of [A-Za-z0-9_-]. */
  sessionKey: string;
  /** What the demo user typed. Empty on the web starts the demo (or repeats the current prompt). */
  text: string;
  /** Origin for the finish link (a localhost lane server). Defaults to the canonical origin. */
  origin?: string;
};

export type DemoTurnResult =
  | {
      ok: true;
      /** Structured, for the web chat. */
      bubbles: DemoBubble[];
      /** The same bubbles as flat SMS-ready strings (`sample` ones carry a "Sample text:" prefix). */
      messages: string[];
      step: DemoStep;
      /** The scripted moments and the setup questions are done; `finishUrl` is set. */
      finished: boolean;
      /** The user ended the demo ("exit"). */
      ended: boolean;
      /** Phone-bound (SMS) or open (web) finish-setup link, only once finished. */
      finishUrl: string | null;
      /** Quick replies a chat UI can offer for the current step. */
      suggestions: string[];
    }
  | { ok: false; reason: "invalid_session" | "unavailable" };

/** A web session id is opaque but must be unguessable-looking and bounded. */
export const DEMO_WEB_SESSION_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** A demo idle for longer than this is over; the next text starts fresh. */
export const DEMO_IDLE_MINUTES = 120;
