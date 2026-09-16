import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const emitActionEvent = vi.fn(async () => ({ eventId: "e", duplicate: false, delivered: 0, submitted: 0, deferred: 0, failed: 0 }));
vi.mock("@/lib/action-events.server", () => ({
  emitActionEvent: (...args: unknown[]) => emitActionEvent(...(args as [])),
}));

const enqueueWebhookEvent = vi.fn(async () => undefined);
vi.mock("@/lib/webhooks/deliver.server", () => ({
  enqueueWebhookEvent: (...args: unknown[]) => enqueueWebhookEvent(...(args as [])),
}));

import { renderWorkOrderEvent, workOrderEvent } from "@/lib/work-order-events.server";

const facts = {
  reference: "WO-1042",
  title: "Leaking sink",
  propertyLabel: "12 Main St · 3B",
  vendorName: "North Plumbing",
  amountCents: 12550,
};

function fakeDb(profiles: Record<string, { email?: string; full_name?: string }>) {
  const from = () => {
    let matchedId = "";
    return {
      select() { return this; },
      eq(_c: string, value: string) { matchedId = value; return this; },
      maybeSingle() {
        const row = profiles[matchedId];
        return Promise.resolve({ data: row ? { email: row.email, full_name: row.full_name } : null, error: null });
      },
    };
  };
  return { from } as unknown as SupabaseClient;
}

describe("work-order events: team audience (WS5)", () => {
  beforeEach(() => {
    emitActionEvent.mockClear();
    enqueueWebhookEvent.mockClear();
  });

  it("renders team copy for accepted and completed, and nothing for every other event", () => {
    expect(renderWorkOrderEvent("accepted", "team", facts)?.text).toContain("assigned to");
    expect(renderWorkOrderEvent("completed", "team", facts)?.text).toContain("marked done");
    expect(renderWorkOrderEvent("created", "team", facts)).toBeNull();
    expect(renderWorkOrderEvent("scheduled", "team", facts)).toBeNull();
  });

  it("injects exactly one team recipient for a manager-attributed 'accepted' event", async () => {
    const db = fakeDb({});
    await workOrderEvent(db, {
      eventId: "wo-1:accepted", event: "accepted", managerUserId: "owner-1", workOrderId: "wo-1",
      senderUserId: "owner-1", senderEmail: "owner@example.com", facts,
      recipients: [{ audience: "manager", userId: "owner-1" }, { audience: "resident", email: "resident@example.com" }],
    });
    expect(emitActionEvent).toHaveBeenCalledTimes(1);
    const call = emitActionEvent.mock.calls[0]![1] as { recipients: Array<{ audience: string }> };
    expect(call.recipients.map((r) => r.audience).sort()).toEqual(["manager", "resident", "team"]);
  });

  it("does not inject a team recipient for events other than accepted/completed", async () => {
    const db = fakeDb({});
    await workOrderEvent(db, {
      eventId: "wo-1:scheduled", event: "scheduled", managerUserId: "owner-1", workOrderId: "wo-1",
      senderUserId: "owner-1", senderEmail: "owner@example.com", facts,
      recipients: [{ audience: "manager", userId: "owner-1" }],
    });
    const call = emitActionEvent.mock.calls[0]![1] as { recipients: Array<{ audience: string }> };
    expect(call.recipients.some((r) => r.audience === "team")).toBe(false);
  });

  it("posts the team notice exactly ONCE — as the manager — when a vendor's own acceptance splits into a cross-party send", async () => {
    const db = fakeDb({ "owner-1": { email: "owner@example.com", full_name: "Owner Name" } });
    await workOrderEvent(db, {
      eventId: "wo-1:accepted", event: "accepted", managerUserId: "owner-1", workOrderId: "wo-1",
      senderUserId: "vendor-1", senderEmail: "vendor@example.com", facts,
      recipients: [
        { audience: "vendor", userId: "vendor-1" },
        { audience: "resident", email: "resident@example.com" },
        { audience: "manager", userId: "owner-1" },
      ],
      senderAudience: "vendor",
    });
    // Two emitActionEvent calls: the vendor's own leg (vendor + manager, sent
    // as the vendor — existing cross-party split behavior, unchanged by this
    // slice) and the "as-manager" leg carrying resident + the injected team
    // recipient, sent as the manager.
    expect(emitActionEvent).toHaveBeenCalledTimes(2);
    const teamCalls = emitActionEvent.mock.calls.filter(([, call]) =>
      (call as { recipients: Array<{ audience: string }> }).recipients.some((r) => r.audience === "team"),
    );
    expect(teamCalls).toHaveLength(1);
    const [, asManagerCall] = teamCalls[0]!;
    const typed = asManagerCall as { senderUserId: string; recipients: Array<{ audience: string }> };
    expect(typed.senderUserId).toBe("owner-1");
    expect(typed.recipients.map((r) => r.audience).sort()).toEqual(["resident", "team"]);
  });

  it("never double-injects when a caller already supplied its own team recipient", async () => {
    const db = fakeDb({});
    await workOrderEvent(db, {
      eventId: "wo-1:completed", event: "completed", managerUserId: "owner-1", workOrderId: "wo-1",
      senderUserId: "owner-1", senderEmail: "owner@example.com", facts,
      recipients: [{ audience: "manager", userId: "owner-1" }, { audience: "team", userId: "owner-1" }],
    });
    const call = emitActionEvent.mock.calls[0]![1] as { recipients: Array<{ audience: string }> };
    expect(call.recipients.filter((r) => r.audience === "team")).toHaveLength(1);
  });
});
