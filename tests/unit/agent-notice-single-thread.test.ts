/**
 * AXI-150 — "there are so many proplane assisntnts not sure why. there should be
 * one sinuglar proplane assisntants that you can message."
 *
 * Every agent notice used to mint its own thread id (`Date.now()` plus a random
 * suffix when no idempotency key was supplied), so the manager's inbox filled
 * with a separate "PropLane Assistant" conversation per notification.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/manager-notification-routing.server", () => ({
  resolveManagerNotificationChannels: vi.fn(async () => ({ inbox: true, push: false, sms: false })),
  sendManagerNotificationSms: vi.fn(async () => undefined),
}));

type Row = {
  id: string;
  updated_at?: string;
  row_data: { messages?: { id: string; body: string }[] };
};

/**
 * The thread row is shared with the SMS mirror, so the notice write is a guarded
 * read-modify-write: read `row_data` + `updated_at`, then insert (new thread) or
 * update with that `updated_at` as the compare-and-set (two notices inside one
 * read window must not lose a turn).
 */
function makeDb(rows: Map<string, Row>) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            const first = [...rows.values()][0];
            return { data: first ? { row_data: first.row_data, updated_at: first.updated_at ?? null } : null, error: null };
          },
        }),
      }),
      insert: async (payload: Row) => {
        rows.set(payload.id, payload);
        return { error: null };
      },
      update: (payload: Partial<Row>) => {
        const filters: Record<string, unknown> = {};
        const chain = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return chain;
          },
          select: async () => {
            const id = String(filters.id ?? "");
            const row = rows.get(id);
            if (!row) return { data: [], error: null };
            if (filters.updated_at !== undefined && row.updated_at !== filters.updated_at) {
              return { data: [], error: null };
            }
            rows.set(id, { ...row, ...payload } as Row);
            return { data: [{ id }], error: null };
          },
        };
        return chain;
      },
    }),
  } as never;
}

const LANDLORD = "mgr-1";
let rows: Map<string, Row>;

beforeEach(() => {
  rows = new Map();
});

async function notify(subject: string, text: string, idempotencyKey?: string) {
  const { notifyManagerFromAgent } = await import("@/lib/agent-notify.server");
  return notifyManagerFromAgent(makeDb(rows), {
    landlordId: LANDLORD,
    subject,
    text,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

describe("PropLane Assistant is one conversation", () => {
  it("keeps assistant reply routing after a typed escalation notice", async () => {
    const { notifyManagerFromAgent } = await import("@/lib/agent-notify.server");
    await notifyManagerFromAgent(makeDb(rows), {
      landlordId: LANDLORD, subject: "Needs a reply", text: "A prospect needs help",
      threadType: "leasing_sms_escalation",
    });
    expect(rows.get(`agent_notice_${LANDLORD}`)).toMatchObject({
      thread_type: "agent_notice", row_data: { threadType: "agent_notice", messages: [
        expect.objectContaining({ noticeType: "leasing_sms_escalation" }),
      ] },
    });
  });
  it("keeps every notice in a single thread", async () => {
    await notify("First", "one");
    await notify("Second", "two");
    await notify("Third", "three");
    expect(rows.size).toBe(1);
  });

  it("uses a stable per-manager thread id", async () => {
    await notify("First", "one");
    expect([...rows.keys()][0]).toBe(`agent_notice_${LANDLORD}`);
  });

  it("appends each notice as a turn rather than replacing the last", async () => {
    await notify("First", "one");
    await notify("Second", "two");
    const messages = [...rows.values()][0]!.row_data.messages ?? [];
    expect(messages.map((m) => m.body)).toEqual(["one", "two"]);
  });

  it("still dedupes a retry, now at the message level", async () => {
    await notify("Reminder", "pay rent", "rent-2026-09");
    await notify("Reminder", "pay rent", "rent-2026-09");
    const messages = [...rows.values()][0]!.row_data.messages ?? [];
    expect(messages).toHaveLength(1);
  });

  it("reports a deduped retry as delivered, not failed", async () => {
    await notify("Reminder", "pay rent", "rent-2026-09");
    const second = await notify("Reminder", "pay rent", "rent-2026-09");
    expect(second.delivered).toBe(true);
  });
});
