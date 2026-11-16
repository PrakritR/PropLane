/**
 * A PropLane Assistant notice always shows its words (Nov 15: a Nov 13 booking-cancellation notice thread opened with
 * no body). Writer: an empty rendered text falls back to the subject and a notice with neither is never written.
 * Reader: a stored blank notice (root or turn) renders its subject instead of an empty bubble.
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
  return notifyManagerFromAgent(makeDb(rows), { landlordId: LANDLORD, subject, text, ...(idempotencyKey ? { idempotencyKey } : {}) });
}

describe("notice writer always stores a body", () => {
  it("stores the formatted booking text (house, room, dates) on the row and on the turn", async () => {
    const { formatBookingNotice } = await import("@/lib/manager-notice-format");
    const notice = formatBookingNotice({ created: false, guestName: "Priya Nair", channel: "Airbnb", house: "5259 Brooklyn Ave", room: "Room 2", checkIn: "2026-11-06", checkOutExclusive: "2026-11-09" });
    await notify(notice.subject, notice.sms, "cancel-1");
    const stored = [...rows.values()][0]!.row_data as { body?: string; time?: string; messages: Array<{ body: string; noticeSubject?: string }> };
    expect(stored.body).toContain("5259 Brooklyn Ave");
    expect(stored.body).toContain("Room 2");
    expect(stored.body).toContain("Nov 6");
    expect(stored.time).toBeTruthy();
    expect(stored.messages[0]!.body).toBe(stored.body);
    expect(stored.messages[0]!.noticeSubject).toBe("Airbnb booking cancelled");
  });

  it("falls back to the subject when the text rendered empty", async () => {
    await notify("Airbnb booking cancelled", "   ", "cancel-2");
    const stored = [...rows.values()][0]!.row_data as { body?: string; preview?: string; messages: Array<{ body: string }> };
    expect(stored.body).toBe("Airbnb booking cancelled");
    expect(stored.preview).toBe("Airbnb booking cancelled");
    expect(stored.messages[0]!.body).toBe("Airbnb booking cancelled");
  });

  it("writes nothing for a notice with neither a subject nor a text", async () => {
    const result = await notify(" ", "", "cancel-3");
    expect(result.delivered).toBe(false);
    expect(rows.size).toBe(0);
  });
});

describe("notice reader renders old blank notices", () => {
  const base = { folder: "inbox", from: "PropLane Assistant", email: "", time: "", unread: true, threadType: "agent_notice" } as const;

  it("a stored thread with a subject but no body shows the subject", async () => {
    const { inboxThreadMessages } = await import("@/lib/portal-inbox-storage");
    const turns = inboxThreadMessages({ ...base, id: "agent_notice_mgr-1", subject: "Airbnb booking cancelled", preview: "", body: "", messages: [] } as never);
    expect(turns.map((t) => t.body)).toEqual(["Airbnb booking cancelled"]);
  });

  it("a blank turn carrying its notice subject shows that subject, and real bodies are untouched", async () => {
    const { inboxThreadMessages } = await import("@/lib/portal-inbox-storage");
    const turns = inboxThreadMessages({
      ...base, id: "agent_notice_mgr-1", subject: "PropLane Assistant", preview: "", body: "Latest real text",
      messages: [
        { id: "m1", from: "PropLane Assistant", body: "", at: "2026-11-13T10:00:00Z", noticeSubject: "Airbnb booking cancelled" },
        { id: "m2", from: "PropLane Assistant", body: "Latest real text", at: "2026-11-14T10:00:00Z" },
      ],
    } as never);
    expect(turns.map((t) => t.body)).toEqual(["Latest real text", "Airbnb booking cancelled"]);
  });

  it("a non-assistant thread keeps its blank body (nothing invented)", async () => {
    const { inboxThreadMessages } = await import("@/lib/portal-inbox-storage");
    const turns = inboxThreadMessages({ ...base, threadType: undefined, from: "Priya", id: "t1", subject: "Hello", preview: "", body: "", messages: [] } as never);
    expect(turns[0]!.body).toBe("");
  });
});
