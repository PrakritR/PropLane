import "server-only";

import type { NextResponse } from "next/server";

/**
 * Twilio abandons a webhook after 15 seconds and logs error 11200 (it logged HTTP 502 four times in a week: Oct 28, 29 twice,
 * 31), and a shared-line text that did get its reply never retries. The route therefore ACKS WITHIN A BUDGET: when the work
 * (routing, the lead agent, the model) is still running at `INBOUND_ACK_BUDGET_MS`, Twilio gets an empty 200 TwiML now and the
 * work finishes after the response. A reply the work would have put in the TwiML is then sent through the Messaging API
 * (`sendLate`) instead, so a slow turn is a late answer, never a dropped one.
 *
 * The early 200 is only ever sent once the work says it is SAFE to send one (`canAck`), which the route says in exactly
 * two states. After `claim_sms_inbound` succeeded: from that point a turn that does not finish is replayed by
 * `/api/cron/sms-inbound-recovery` (every minute). And, on the shared line, once this text's LATE REPLY is claimed under
 * its MessageSid before the seam runs — that turn answers in the TwiML itself, so what has to be durable there is not a
 * replayable receipt but the guarantee that `sendLate` goes out exactly once per text. Before either, there is nothing to
 * pick the turn up from, so the real response — including every retryable 5xx ("Workspace unavailable.", "Inbound receipt
 * unavailable.", …) — has to reach Twilio or the inbound text is lost. Past the budget with nothing claimed, this keeps
 * waiting and polls `canAck` until the work settles.
 */
export const INBOUND_ACK_BUDGET_MS = 9_000;

/** How often `canAck` is re-asked once the budget has passed with nothing claimed yet. */
export const INBOUND_ACK_CLAIM_POLL_MS = 250;

export type LateMessage = { body: string; mediaUrl?: string };

const unescapeXml = (value: string): string => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The `<Message>` bodies (and their `<Media>`) of a TwiML document, in order. Empty TwiML has none. */
export function parseTwimlMessages(xml: string): LateMessage[] {
  const out: LateMessage[] = [];
  for (const match of xml.matchAll(/<Message>([\s\S]*?)<\/Message>/g)) {
    const inner = match[1] ?? "";
    const body = /<Body>([\s\S]*?)<\/Body>/.exec(inner);
    const media = /<Media>([\s\S]*?)<\/Media>/.exec(inner);
    const text = unescapeXml(body ? body[1]! : inner).trim();
    if (!text) continue;
    out.push({ body: text, ...(media ? { mediaUrl: unescapeXml(media[1]!).trim() } : {}) });
  }
  return out;
}

export type AckOptions = {
  budgetMs?: number;
  /** An empty 200 TwiML. */
  ack: () => NextResponse;
  /** Run `task` after the response (the platform's post-response continuation). */
  schedule: (task: () => Promise<void>) => void;
  /** Deliver a reply the work wanted to put in the TwiML, after the ack went out. */
  sendLate: (messages: LateMessage[]) => Promise<void>;
  /**
   * Whether the work has reached a point where an early 200 cannot lose the message — for the inbound
   * route, a claimed receipt the recovery cron can replay. Defaults to always; a `false` answer keeps
   * the real response (and its status) going back to Twilio however long the work takes.
   */
  canAck?: () => boolean;
  onLate?: (info: { status: number; messages: number }) => void;
};

function sleep(ms: number): { promise: Promise<null>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}

/**
 * Await `work` for at most the budget. Over it, and once `canAck` agrees the message is durable: ack now, and
 * let the work finish (and any TwiML reply go out) afterwards. While `canAck` says no, the work's own response
 * is what Twilio gets, so a pre-claim failure still asks for a retry.
 */
export async function ackWithinBudget(work: Promise<NextResponse>, opts: AckOptions): Promise<NextResponse> {
  const budget = opts.budgetMs ?? INBOUND_ACK_BUDGET_MS;
  const canAck = opts.canAck ?? (() => true);
  const settled = work.then((response) => ({ response }));
  // The scheduled continuation below is the one place a failure is reported; keep the derived
  // promise from surfacing a second, unhandled rejection when the ack already went out.
  void settled.catch(() => undefined);
  for (let wait = budget; ; wait = INBOUND_ACK_CLAIM_POLL_MS) {
    const timer = sleep(wait);
    try {
      const first = await Promise.race([settled, timer.promise]);
      if (first) return first.response;
    } finally {
      timer.cancel();
    }
    if (canAck()) break;
  }
  opts.schedule(async () => {
    try {
      const late = await work;
      const messages = late.status === 200 ? parseTwimlMessages(await late.text()) : [];
      opts.onLate?.({ status: late.status, messages: messages.length });
      if (messages.length > 0) await opts.sendLate(messages);
    } catch (error) {
      console.error("twilio inbound late work failed", error instanceof Error ? error.name : "unknown");
    }
  });
  return opts.ack();
}
