import "server-only";

import type { NextResponse } from "next/server";

/**
 * Twilio abandons a webhook after 15 seconds and logs error 11200 (it logged HTTP 502 four times in a week: Oct 28, 29 twice,
 * 31), and a shared-line text that did get its reply never retries. The route therefore ACKS WITHIN A BUDGET: when the work
 * (routing, the lead agent, the model) is still running at `INBOUND_ACK_BUDGET_MS`, Twilio gets an empty 200 TwiML now and the
 * work finishes after the response. A reply the work would have put in the TwiML is then sent through the Messaging API
 * (`sendLate`) instead, so a slow turn is a late answer, never a dropped one. A claimed receipt that does not finish is
 * recovered by `/api/cron/sms-inbound-recovery` (every minute), which this does not change.
 */
export const INBOUND_ACK_BUDGET_MS = 9_000;

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
  onLate?: (info: { status: number; messages: number }) => void;
};

/** Await `work` for at most the budget. Over it: ack now, and let the work finish (and any TwiML reply go out) afterwards. */
export async function ackWithinBudget(work: Promise<NextResponse>, opts: AckOptions): Promise<NextResponse> {
  const budget = opts.budgetMs ?? INBOUND_ACK_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budget);
  });
  try {
    const first = await Promise.race([work.then((response) => ({ response })), early]);
    if (first) return first.response;
  } finally {
    if (timer) clearTimeout(timer);
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
