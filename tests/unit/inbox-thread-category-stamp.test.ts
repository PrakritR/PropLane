import { describe, expect, it, vi } from "vitest";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";

/**
 * The category a conversation is ABOUT is what the list renders as its chip.
 * Nothing else on the row carries a topic, so if the write path drops it the
 * chip can never appear — and it fails silently, because a thread with no
 * category renders correctly as "no chip".
 *
 * Both senders matter: `deliverPortalInboxMessage` (server notices) and
 * `/api/portal/send-inbox-message` (the app's own compose) are PARALLEL
 * implementations and both call this function.
 */
function fakeDb(captured: { writes: unknown[] }) {
  const rows = new Map<string, Record<string, unknown>>();
  function table() {
    const filters: Array<[string, unknown]> = [];
    const matches = (row: Record<string, unknown>) => filters.every(([column, value]) => {
      if (column === "row_data->>folder") return String((row.row_data as Record<string, unknown> | undefined)?.folder ?? "") === value;
      if (column === "row_data->>email") return String((row.row_data as Record<string, unknown> | undefined)?.email ?? "") === value;
      return row[column] === value;
    });
    const chain = {
      select: () => chain,
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return chain;
      },
      order: () => chain,
      limit: async () => ({ data: [...rows.values()].filter(matches), error: null }),
      maybeSingle: async () => ({ data: [...rows.values()].find(matches) ?? null, error: null }),
      upsert: async (record: Record<string, unknown>) => {
        const id = String(record.id);
        rows.set(id, { ...(rows.get(id) ?? {}), ...record });
        captured.writes.push(record);
        return { data: null, error: null };
      },
      insert: async (record: Record<string, unknown>) => {
        const id = String(record.id);
        if (rows.has(id)) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
        rows.set(id, record);
        captured.writes.push(record);
        return { data: null, error: null };
      },
    };
    return chain;
  }
  return {
    from: () => table(),
  } as never;
}

const base = {
  scope: "axis_portal_inbox_resident_v1",
  folder: "inbox" as const,
  ownerUserId: "res-1",
  participantEmail: "resident@example.com",
  otherPartyEmail: "manager@example.com",
  fallbackId: "msg_inbox_1_abcd",
  fromName: "Test Manager",
  subject: "Maintenance visit scheduled",
  body: "The plumber is booked for Thursday.",
  preview: "The plumber is booked for Thursday.",
  when: "Sep 8, 9:00 AM",
  unread: true,
  outbound: false,
};

describe("a new conversation records what it is about", () => {
  it("writes the category onto the thread row", async () => {
    const captured = { writes: [] as unknown[] };
    await deliverPortalMessageThreadSide(fakeDb(captured), { ...base, category: "maintenance" });

    const row = captured.writes.at(-1) as { row_data?: Record<string, unknown> };
    expect(row?.row_data?.category).toBe("maintenance");
  });

  it("writes NO category when the sender named none", async () => {
    // An absent category must stay absent rather than becoming a guess: the row
    // renders no chip, which is the honest state for every conversation written
    // before the send path began recording one.
    const captured = { writes: [] as unknown[] };
    await deliverPortalMessageThreadSide(fakeDb(captured), base);

    const row = captured.writes.at(-1) as { row_data?: Record<string, unknown> };
    expect(row?.row_data && "category" in row.row_data).toBe(false);
  });
});

describe("the app's own send route stamps it too", () => {
  it("passes eventCategory into every thread side it writes", async () => {
    // Guards the gap this test was written for: the route had `eventCategory`
    // in scope for channel gating but never handed it to the thread write, so a
    // conversation started from the app carried none while the identical
    // message sent server-side did.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/portal/send-inbox-message/route.ts", "utf8");
    const sides = src.match(/deliverPortalMessageThreadSide\(db, \{/g) ?? [];
    const stamps = src.match(/category: eventCategory \?\? undefined/g) ?? [];
    expect(sides.length).toBeGreaterThan(0);
    expect(stamps.length).toBe(sides.length);
  });
});

vi.mock("@/lib/webhooks/enqueue", () => ({ enqueueWebhookEvent: async () => {} }));
