/**
 * `GET /api/portal/reminder-history` — the manager's reminder Sent history.
 *
 * The most important test in this file is the first one: scope comes ONLY
 * from the authenticated session, and a `managerUserId` passed in the query
 * string is completely ignored, never merely "validated".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireManagerRouteUser = vi.fn();

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: () => requireManagerRouteUser(),
}));

type Row = {
  id: string;
  manager_user_id: string;
  kind: string;
  status: string;
  recipient_email: string | null;
  recipient_phone: string | null;
  recipient_role: string;
  send_at: string;
  sent_at: string | null;
  last_error: string | null;
  attempts: number;
  created_at: string;
};

/**
 * A minimal stand-in for the supabase-js PostgREST query builder: enough of
 * `.select/.eq/.order/.range` plus the thenable contract (`await` calls
 * `.then`) for this route's exact usage, operating over an in-memory table.
 */
function createFakeDb(rows: Row[]) {
  return {
    from(table: string) {
      if (table !== "portal_reminder_records") throw new Error(`unexpected table: ${table}`);
      let filtered = [...rows];
      let range: [number, number] | null = null;
      const builder = {
        select() {
          return builder;
        },
        eq(col: keyof Row, val: unknown) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        order() {
          return builder;
        },
        range(from: number, to: number) {
          range = [from, to];
          return builder;
        },
        then(onFulfilled: (v: { data: Row[]; error: null }) => unknown, onRejected?: (e: unknown) => unknown) {
          const sorted = [...filtered].sort((a, b) => {
            if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
            return a.id < b.id ? 1 : -1;
          });
          const [from, to] = range ?? [0, sorted.length - 1];
          const data = sorted.slice(from, to + 1);
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

function row(over: Partial<Row>): Row {
  return {
    id: `row-${Math.random().toString(36).slice(2)}`,
    manager_user_id: "mgr-1",
    kind: "tour",
    status: "sent",
    recipient_email: "guest@example.com",
    recipient_phone: null,
    recipient_role: "counterparty",
    send_at: "2026-09-10T10:00:00.000Z",
    sent_at: "2026-09-10T10:00:05.000Z",
    last_error: null,
    attempts: 1,
    created_at: "2026-09-10T09:00:00.000Z",
    ...over,
  };
}

function getReq(qs: string): Request {
  return new Request(`http://localhost/api/portal/reminder-history${qs}`);
}

const route = await import("@/app/api/portal/reminder-history/route");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/portal/reminder-history", () => {
  it("ignores a managerUserId query param and never leaks another manager's rows", async () => {
    const mgr1Rows = [
      row({ id: "mgr1-a", manager_user_id: "mgr-1", created_at: "2026-09-10T09:00:00.000Z" }),
      row({ id: "mgr1-b", manager_user_id: "mgr-1", created_at: "2026-09-10T08:00:00.000Z" }),
    ];
    const mgr2Rows = [
      row({ id: "mgr2-a", manager_user_id: "mgr-2", created_at: "2026-09-10T09:30:00.000Z" }),
      row({ id: "mgr2-b", manager_user_id: "mgr-2", created_at: "2026-09-10T08:30:00.000Z" }),
    ];
    const db = createFakeDb([...mgr1Rows, ...mgr2Rows]);
    requireManagerRouteUser.mockResolvedValue({ db, userId: "mgr-1" });

    // The query string tries to impersonate mgr-2. It must have zero effect.
    const res = await route.GET(getReq("?managerUserId=mgr-2"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(2);
    expect(body.items.map((i: { id: string }) => i.id).sort()).toEqual(["mgr1-a", "mgr1-b"]);
    expect(body.items.some((i: { id: string }) => i.id.startsWith("mgr2"))).toBe(false);
  });

  it("refuses a non-manager caller", async () => {
    requireManagerRouteUser.mockResolvedValue(null);

    const res = await route.GET(getReq(""));

    expect(res.status).toBe(401);
  });

  it("returns last_error verbatim for a failed row", async () => {
    const weirdError = "SMTP 550 5.1.1: mailbox \"foo@bar.com\" not found\nretry budget exhausted after 5 attempts — see logs";
    const db = createFakeDb([
      row({ id: "failed-1", status: "failed", last_error: weirdError, sent_at: null }),
    ]);
    requireManagerRouteUser.mockResolvedValue({ db, userId: "mgr-1" });

    const res = await route.GET(getReq(""));
    const body = await res.json();

    expect(body.items[0].lastError).toBe(weirdError);
  });

  it("rejects an unknown status filter", async () => {
    const db = createFakeDb([row({})]);
    requireManagerRouteUser.mockResolvedValue({ db, userId: "mgr-1" });

    const res = await route.GET(getReq("?status=bogus"));

    expect(res.status).toBe(400);
  });

  it("rejects an unknown kind filter", async () => {
    const db = createFakeDb([row({})]);
    requireManagerRouteUser.mockResolvedValue({ db, userId: "mgr-1" });

    const res = await route.GET(getReq("?kind=bogus"));

    expect(res.status).toBe(400);
  });

  it("labels a work_order row 'Service visit', never 'Work order'", async () => {
    const db = createFakeDb([row({ id: "wo-1", kind: "work_order" })]);
    requireManagerRouteUser.mockResolvedValue({ db, userId: "mgr-1" });

    const res = await route.GET(getReq(""));
    const body = await res.json();

    expect(body.items[0].kindLabel).toBe("Service visit");
    expect(body.items[0].kindLabel.toLowerCase()).not.toContain("work order");
  });

  it("caps the limit server-side when a caller asks for a huge one", async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      row({
        id: `bulk-${String(i).padStart(3, "0")}`,
        created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      }),
    );
    const db = createFakeDb(rows);
    requireManagerRouteUser.mockResolvedValue({ db, userId: "mgr-1" });

    const res = await route.GET(getReq("?limit=999999"));
    const body = await res.json();

    expect(body.items).toHaveLength(100);
    expect(body.nextCursor).toBe("100");
  });

  it("paginates disjoint pages via cursor", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({
        id: `p-${i}`,
        created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      }),
    );
    const db = createFakeDb(rows);
    requireManagerRouteUser.mockResolvedValue({ db, userId: "mgr-1" });

    const page1 = await (await route.GET(getReq("?limit=2"))).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe("2");

    const page2 = await (await route.GET(getReq(`?limit=2&cursor=${page1.nextCursor}`))).json();
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBe("4");

    const page3 = await (await route.GET(getReq(`?limit=2&cursor=${page2.nextCursor}`))).json();
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const ids = [...page1.items, ...page2.items, ...page3.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(5);
  });
});
