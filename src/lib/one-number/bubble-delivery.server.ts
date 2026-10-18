import "server-only";

import { after } from "next/server";
import { splitIntoBubbles, textHasEmoji } from "@/lib/one-number/bubbles";
import { loadFeelSettings } from "@/lib/one-number/feel-settings.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * Send one agent reply as up to three bubbles.
 *
 * Bubble 1 goes out inside the caller's request, through the caller's own send
 * (the same consent / quiet-hours / wallet door as any reply), and its result is
 * what the caller sees. Bubbles 2-3 follow 500-800 ms apart, one after the
 * other, in `after()` (the platform's post-response continuation, never a
 * `setTimeout` in the handler), each awaiting the previous send so they cannot
 * reorder. Each bubble has its own idempotency key (`send` receives its index),
 * so a webhook retry re-sends nothing twice.
 *
 * If the continuation dies, the texter has bubble 1: the answer or the
 * acknowledgement. That is deliberate; the fragile part is always the extra.
 */

export type BubbleSendResult = { ok?: boolean; durablyAccepted?: boolean };

export type BubbleRuntime = {
  sleep: (ms: number) => Promise<void>;
  /** Run `task` after the response. */
  schedule: (task: () => Promise<void>) => void;
  /** Milliseconds between bubbles. */
  gapMs: () => number;
};

export const BUBBLE_GAP_MIN_MS = 500;
export const BUBBLE_GAP_MAX_MS = 800;

export const defaultBubbleRuntime: BubbleRuntime = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (task) => {
    const run = () => task().catch((error) => console.error("sms bubble continuation failed", error instanceof Error ? error.message : "unknown"));
    try {
      after(run);
    } catch {
      // Outside a request there is no continuation to join.
      void run();
    }
  },
  gapMs: () => BUBBLE_GAP_MIN_MS + Math.floor(Math.random() * (BUBBLE_GAP_MAX_MS - BUBBLE_GAP_MIN_MS + 1)),
};

export async function deliverReplyBubbles<R extends BubbleSendResult>(args: {
  text: string;
  enabled: boolean;
  /** The text being answered; an emoji in it lets the reply keep its own. */
  inboundText?: string | null;
  /** Send one bubble. `index` 0 is the first (its idempotency key is the reply's own). */
  send: (text: string, index: number) => Promise<R>;
  runtime?: Partial<BubbleRuntime>;
}): Promise<R> {
  const runtime = { ...defaultBubbleRuntime, ...args.runtime };
  const bubbles = args.enabled ? splitIntoBubbles(args.text, { allowEmoji: textHasEmoji(args.inboundText ?? "") }) : [];
  if (bubbles.length <= 1) return args.send(bubbles[0] ?? args.text, 0);

  const first = await args.send(bubbles[0]!, 0);
  // A refused first bubble (opt-out, quiet hours, budget) stops the rest.
  if (!first.ok && !first.durablyAccepted) return first;

  runtime.schedule(async () => {
    for (let index = 1; index < bubbles.length; index += 1) {
      await runtime.sleep(runtime.gapMs());
      const sent = await args.send(bubbles[index]!, index);
      if (!sent.ok && !sent.durablyAccepted) return;
    }
  });
  return first;
}

/** Idempotency key of bubble `index`: bubble 0 keeps the reply's own key. */
export function bubbleDedupeKey(base: string | null, index: number): string | null {
  if (!base) return null;
  return index === 0 ? base : `${base}_b${index + 1}`;
}

/**
 * Convenience for the agent reply deliverers: bubbles are decided from the
 * workspace's feel settings. No workspace id = no bubbles (a work-number caller
 * that never opted in keeps its single message).
 */
export async function deliverAgentReply<R extends BubbleSendResult>(args: {
  workspaceId?: string | null;
  /** The caller already resolved the setting (the inbound pipeline does). */
  bubbles?: boolean;
  text: string;
  inboundText?: string | null;
  send: (text: string, index: number) => Promise<R>;
  runtime?: Partial<BubbleRuntime>;
}): Promise<R> {
  let enabled = args.bubbles === true;
  const workspaceId = args.workspaceId?.trim();
  if (args.bubbles === undefined && workspaceId) {
    try {
      enabled = (await loadFeelSettings(createSupabaseServiceRoleClient(), { workspaceId })).bubbleReplies;
    } catch {
      enabled = false;
    }
  }
  return deliverReplyBubbles({ text: args.text, enabled, inboundText: args.inboundText, send: args.send, runtime: args.runtime });
}
