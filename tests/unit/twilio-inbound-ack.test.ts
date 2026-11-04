// Twilio abandons a webhook at 15s (error 11200, HTTP 502 four times in a week). Over the budget the route acks with an empty
// 200 and finishes after the response; a reply the work would have put in the TwiML goes out through the API instead.
import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("server-only", () => ({}));

import { ackWithinBudget, parseTwimlMessages } from "@/lib/sms/inbound-ack.server";

const twiml = (messages: string) => new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${messages}</Response>`, { status: 200, headers: { "Content-Type": "text/xml" } });
const ack = () => twiml("");

function harness() {
  const scheduled: Array<() => Promise<void>> = [];
  const sendLate = vi.fn(async (_m: unknown) => undefined);
  return {
    scheduled, sendLate,
    opts: { budgetMs: 20, ack, schedule: (t: () => Promise<void>) => { scheduled.push(t); }, sendLate },
  };
}

describe("ackWithinBudget", () => {
  it("returns the work's own response when it finishes inside the budget", async () => {
    const h = harness();
    const res = await ackWithinBudget(Promise.resolve(twiml("<Message>Hello</Message>")), h.opts);
    expect(await res.text()).toContain("<Message>Hello</Message>");
    expect(h.scheduled).toHaveLength(0);
  });

  it("acks with an empty 200 when the work is slower, then sends the TwiML reply through the API once it finishes", async () => {
    const h = harness();
    const slow = new Promise<NextResponse>((resolve) => setTimeout(() => resolve(twiml("<Message><Body>Open now: 1) Sample House &amp; Co</Body><Media>https://example.com/a.jpg</Media></Message><Message>Reply 1</Message>")), 60));
    const res = await ackWithinBudget(slow, h.opts);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("<Message");
    expect(h.scheduled).toHaveLength(1);
    await h.scheduled[0]!();
    expect(h.sendLate).toHaveBeenCalledWith([
      { body: "Open now: 1) Sample House & Co", mediaUrl: "https://example.com/a.jpg" },
      { body: "Reply 1" },
    ]);
  });

  it("late work that returns an error, or no reply, sends nothing", async () => {
    const h = harness();
    const failing = new Promise<NextResponse>((resolve) => setTimeout(() => resolve(NextResponse.json({ error: "x" }, { status: 503 })), 40));
    await ackWithinBudget(failing, h.opts);
    await h.scheduled[0]!();
    const empty = new Promise<NextResponse>((resolve) => setTimeout(() => resolve(ack()), 40));
    await ackWithinBudget(empty, h.opts);
    await h.scheduled[1]!();
    expect(h.sendLate).not.toHaveBeenCalled();
  });

  it("late work that throws is contained", async () => {
    const h = harness();
    const rejecting = new Promise<NextResponse>((_r, reject) => setTimeout(() => reject(new Error("boom")), 40));
    rejecting.catch(() => undefined);
    await ackWithinBudget(rejecting, h.opts);
    await expect(h.scheduled[0]!()).resolves.toBeUndefined();
  });
});

describe("parseTwimlMessages", () => {
  it("reads plain and media messages in order and skips empty ones", () => {
    expect(parseTwimlMessages(`<Response><Message>A &lt;b&gt;</Message><Message><Body>B</Body><Media>https://x.test/p.png</Media></Message><Message></Message></Response>`)).toEqual([
      { body: "A <b>" },
      { body: "B", mediaUrl: "https://x.test/p.png" },
    ]);
    expect(parseTwimlMessages(`<Response></Response>`)).toEqual([]);
  });
});
