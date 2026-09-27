import { describe, expect, it, vi } from "vitest";
import { loadRecentDeliveredReplies } from "@/lib/agent/leasing-sms-agent.server";
import { isStandaloneSmsAcknowledgment } from "@/lib/sms/standalone-acknowledgment";
import { suppressRedundantLeasingReplyTool } from "@/lib/tools/domains/leasing-sms";
import type { AgentContext } from "@/lib/tools/context";
import { buildRegistry, runReadTool } from "@/lib/tools/registry";

type OutboxRow = { id: string; body: string; updated_at: string; status: string };

function outboxDb(rows: OutboxRow[]) {
  const filters = new Map<string, unknown>();
  const query: Record<string, unknown> = {};
  const chain = () => query;
  query.select = chain;
  query.eq = vi.fn((field: string, value: unknown) => {
    filters.set(field, value);
    return query;
  });
  query.gte = vi.fn((field: string, value: unknown) => {
    filters.set(field, { gte: value });
    return query;
  });
  query.order = chain;
  query.limit = chain;
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
    const data = rows.filter((row) => {
      const status = filters.get("status");
      const updatedAt = filters.get("updated_at") as { gte?: unknown } | undefined;
      return (status === undefined || row.status === status) &&
        (!updatedAt?.gte || row.updated_at >= String(updatedAt.gte));
    });
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  };
  return { db: { from: vi.fn(() => query) } as unknown as AgentContext["db"], query };
}

function suppressionContext(recentDeliveredReplies: Awaited<ReturnType<typeof loadRecentDeliveredReplies>>): AgentContext {
  return {
    landlordId: "manager-1",
    userId: "manager-1",
    email: "",
    roles: ["leasing_sms_agent"],
    isAdmin: false,
    db: {} as AgentContext["db"],
    leasingScope: {
      sessionId: "session-1",
      prospectPhoneE164: "+12065550123",
      channel: "sms",
      workNumber: "+12065550124",
      currentInboundText: "thanks",
      recentDeliveredReplies,
    },
  };
}

describe("leasing SMS suppression acknowledgment guard", () => {
  it.each([
    "thanks",
    "Thank you!",
    "got it",
    "OK, thanks",
    "understood.",
  ])("accepts a standalone acknowledgment: %s", (text) => {
    expect(isStandaloneSmsAcknowledgment(text)).toBe(true);
  });

  it.each([
    "so each room has its own resident? no more than 3 people in the house?",
    "Can you repeat that?",
    "thanks, but is Room 3 shared?",
    "got it - what is the total capacity",
    "yes",
    "no",
    "okay",
    "sounds good",
    "perfect",
    "Room 3 has two residents",
    "thanks for confirming the house allows four people",
  ])("rejects a question, correction, confirmation, or added fact: %s", (text) => {
    expect(isStandaloneSmsAcknowledgment(text)).toBe(false);
  });
});

describe("leasing SMS delivered-reply candidates", () => {
  const now = Date.now();
  const originalInboundAt = new Date(now - 30_000).toISOString();
  const deliveredBeforeOriginal = new Date(now - 45_000).toISOString();
  const deliveredAfterOriginalBeforeIngress = new Date(now - 15_000).toISOString();

  it("keeps only a delivery that precedes the authenticated original inbound event", async () => {
    const { db } = outboxDb([
      { id: "delivered-before", body: "Here are the details.", updated_at: deliveredBeforeOriginal, status: "delivered" },
      { id: "delivered-after", body: "This arrived after the text.", updated_at: deliveredAfterOriginalBeforeIngress, status: "delivered" },
    ]);

    await expect(loadRecentDeliveredReplies(db, {
      landlordId: "manager-1",
      phone: "+12065550123",
      originalInboundOccurredAt: originalInboundAt,
    })).resolves.toEqual([{
      messageId: "delivered-before",
      text: "Here are the details.",
      deliveredAt: deliveredBeforeOriginal,
    }]);
  });

  it.each(["submitted", "sent", "failed", "unknown"]) (
    "rejects a %s delivery status before the suppression tool can see it",
    async (status) => {
      const { db, query } = outboxDb([{
        id: `${status}-outbox`, body: "Earlier reply.", updated_at: deliveredBeforeOriginal, status,
      }]);

      await expect(loadRecentDeliveredReplies(db, {
        landlordId: "manager-1",
        phone: "+12065550123",
        originalInboundOccurredAt: originalInboundAt,
      })).resolves.toEqual([]);
      expect(query.eq).toHaveBeenCalledWith("status", "delivered");
    },
  );

  it("fails closed for a missing or invalid original event timestamp", async () => {
    const { db } = outboxDb([{
      id: "delivered-before", body: "Earlier reply.", updated_at: deliveredBeforeOriginal, status: "delivered",
    }]);
    await expect(loadRecentDeliveredReplies(db, {
      landlordId: "manager-1", phone: "+12065550123",
    })).resolves.toEqual([]);
    await expect(loadRecentDeliveredReplies(db, {
      landlordId: "manager-1", phone: "+12065550123", originalInboundOccurredAt: "not-a-timestamp",
    })).resolves.toEqual([]);
  });

  it("rejects an unknown reference id after selecting real delivered candidates", async () => {
    const { db } = outboxDb([{
      id: "delivered-before", body: "Earlier reply.", updated_at: deliveredBeforeOriginal, status: "delivered",
    }]);
    const candidates = await loadRecentDeliveredReplies(db, {
      landlordId: "manager-1", phone: "+12065550123", originalInboundOccurredAt: originalInboundAt,
    });
    expect(candidates).toHaveLength(1);

    await expect(runReadTool(
      buildRegistry([suppressRedundantLeasingReplyTool]),
      suppressionContext(candidates),
      "suppress_redundant_reply",
      { recentOutboundMessageId: "invented-outbox", reason: "acknowledgment" },
    )).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not a confirmed recent delivered reply/i) });
  });
});
