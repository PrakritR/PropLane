import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  feel: vi.fn(),
}));

vi.mock("next/server", () => ({ after: () => { throw new Error("outside a request"); } }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/one-number/feel-settings.server", () => ({ loadFeelSettings: mocks.feel }));

import { bubbleDedupeKey, deliverAgentReply, deliverReplyBubbles } from "@/lib/one-number/bubble-delivery.server";

const LONG =
  "Yes, Room 3 is open and rent is $950 a month. Tours run weekdays after 4 pm and weekends from 10 am. " +
  "Tell me which day works and I will book it. You can also apply any time from the link I send after the tour.";

function runtime() {
  const order: string[] = [];
  const tasks: (() => Promise<void>)[] = [];
  return {
    order,
    tasks,
    rt: {
      sleep: async (ms: number) => { order.push(`sleep:${ms}`); },
      schedule: (task: () => Promise<void>) => { tasks.push(task); },
      gapMs: () => 650,
    },
  };
}

describe("deliverReplyBubbles", () => {
  beforeEach(() => mocks.send.mockReset().mockImplementation(async (text: string) => ({ ok: true, text })));

  it("sends one message untouched when bubbles are off", async () => {
    const { rt, tasks } = runtime();
    const result = await deliverReplyBubbles({ text: LONG, enabled: false, send: mocks.send, runtime: rt });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(LONG, 0);
    expect(result.ok).toBe(true);
    expect(tasks).toHaveLength(0);
  });

  it("sends bubble 1 now and the rest later, in order, with a gap before each", async () => {
    const { rt, tasks, order } = runtime();
    const sent: string[] = [];
    mocks.send.mockImplementation(async (text: string, index: number) => { sent.push(`${index}:${text}`); order.push(`send:${index}`); return { ok: true }; });
    await deliverReplyBubbles({ text: LONG, enabled: true, send: mocks.send, runtime: rt });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^0:Yes, Room 3 is open/);
    expect(tasks).toHaveLength(1);
    await tasks[0]!();
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.map((s) => Number(s.split(":")[0]))).toEqual(sent.map((_, i) => i));
    expect(order.filter((o) => o.startsWith("sleep")).every((o) => o === "sleep:650")).toBe(true);
    // every follow-up bubble is preceded by its sleep
    for (let i = 1; i < sent.length; i += 1) expect(order.indexOf(`send:${i}`)).toBeGreaterThan(order.indexOf("sleep:650"));
  });

  it("stops after a refused first bubble and returns that refusal", async () => {
    const { rt, tasks } = runtime();
    mocks.send.mockResolvedValue({ ok: false, error: "recipient_opted_out" });
    const result = await deliverReplyBubbles({ text: LONG, enabled: true, send: mocks.send, runtime: rt });
    expect(result).toMatchObject({ ok: false, error: "recipient_opted_out" });
    expect(tasks).toHaveLength(0);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("halts the remaining bubbles when a later one is refused", async () => {
    const { rt, tasks } = runtime();
    mocks.send.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    await deliverReplyBubbles({ text: LONG, enabled: true, send: mocks.send, runtime: rt });
    await tasks[0]!();
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("a short reply is one send and schedules nothing", async () => {
    const { rt, tasks } = runtime();
    await deliverReplyBubbles({ text: "Wi-Fi is 4709A, password sunny42.", enabled: true, send: mocks.send, runtime: rt });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(0);
  });
});

describe("bubbleDedupeKey", () => {
  it("keeps the reply's own key for bubble 1 and suffixes the rest", () => {
    expect(bubbleDedupeKey("inbound_reply_SM1", 0)).toBe("inbound_reply_SM1");
    expect(bubbleDedupeKey("inbound_reply_SM1", 1)).toBe("inbound_reply_SM1_b2");
    expect(bubbleDedupeKey("inbound_reply_SM1", 2)).toBe("inbound_reply_SM1_b3");
    expect(bubbleDedupeKey(null, 1)).toBeNull();
  });
});

describe("deliverAgentReply", () => {
  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue({ ok: true });
    mocks.feel.mockReset();
  });

  it("does not bubble without a workspace or an explicit setting", async () => {
    await deliverAgentReply({ text: LONG, send: mocks.send });
    expect(mocks.feel).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(LONG, 0);
  });

  it("reads the workspace's setting when the caller did not resolve it", async () => {
    mocks.feel.mockResolvedValue({ bubbleReplies: false });
    await deliverAgentReply({ workspaceId: "ws-1", text: LONG, send: mocks.send });
    expect(mocks.feel).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("trusts an explicit setting without a read", async () => {
    await deliverAgentReply({ workspaceId: "ws-1", bubbles: false, text: LONG, send: mocks.send });
    expect(mocks.feel).not.toHaveBeenCalled();
  });
});
