import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

/**
 * /api/manager/payees and the payeeId on /api/expenses. The service-role client bypasses RLS, so
 * the manager pin in every query is the access control: another manager's payee id, a teammate who
 * is not on this team and a bad enum must all be refused.
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined, auth: true }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) })),
}));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: vi.fn(async () => []) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

const authState = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(async () => (state.auth ? { userId: "mgr-1", email: "m@example.com", db: authState.db } : null)),
  assertManagerFinancialsAccess: vi.fn(async () => ({ ok: true })),
}));

import { GET, PATCH, POST } from "@/app/api/manager/payees/route";
import { POST as EXPENSE_POST } from "@/app/api/expenses/route";

const MANAGER = "mgr-1";
const OTHER_MANAGER = "mgr-2";
const TEAMMATE = "11111111-1111-4111-8111-111111111111";
// Payee ids are uuids on the column, and `findOwnedPayee` reads a malformed one as
// "not found" rather than letting Postgres refuse the cast — so the fixtures use
// real uuids, otherwise every owned-payee lookup below 404s for the wrong reason.
const MINE = "33333333-3333-4333-8333-333333333333";
const THEIRS = "44444444-4444-4444-8444-444444444444";
const ARCHIVED = "55555555-5555-4555-8555-555555555555";
const ABSENT = "66666666-6666-4666-8666-666666666666";
const STRANGER = "22222222-2222-4222-8222-222222222222";

function payee(id: string, manager: string, extra: Row = {}): Row {
  return { id, manager_user_id: manager, kind: "other", payee_type: "mortgage", name: `Payee ${id}`, archived_at: null, ...extra };
}

function setup(tables: Record<string, Row[]> = {}) {
  const db = fakeSupabaseClient({
    manager_payees: [],
    account_link_invites: [],
    profiles: [],
    manager_expense_entries: [],
    manager_vendor_records: [],
    ...tables,
  });
  authState.db = db;
  return db as ReturnType<typeof fakeSupabaseClient> & { _tables?: never };
}

const req = (body: unknown, method = "POST") =>
  new Request("http://localhost/api/manager/payees", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  state.auth = true;
  state.cookieValue = undefined;
});

describe("/api/manager/payees", () => {
  it("is 401 without a session", async () => {
    setup();
    state.auth = false;
    expect((await GET()).status).toBe(401);
    expect((await POST(req({ kind: "other", payeeType: "utility", name: "PG&E" }))).status).toBe(401);
  });

  it("lists only this manager's live payees and the team", async () => {
    setup({
      manager_payees: [payee("a", MANAGER), payee("b", OTHER_MANAGER), payee("c", MANAGER, { archived_at: "2026-01-01T00:00:00Z" })],
      account_link_invites: [{ id: "l1", inviter_user_id: MANAGER, invitee_user_id: TEAMMATE, status: "accepted", team_role: "admin", invitee_display_name: "Jordan Lee" }],
    });
    const body = (await (await GET()).json()) as { payees: Array<{ id: string }>; teammates: Array<{ userId: string; name: string }> };
    expect(body.payees.map((p) => p.id)).toEqual(["a"]);
    expect(body.teammates).toEqual([expect.objectContaining({ userId: TEAMMATE, name: "Jordan Lee" })]);
  });

  it("creates a payee pinned to the session manager, ignoring any owner in the body", async () => {
    const db = setup();
    const res = await POST(req({ kind: "other", payeeType: "mortgage", name: " Chase ", accountReference: "4821", manager_user_id: OTHER_MANAGER, managerUserId: OTHER_MANAGER }));
    expect(res.status).toBe(200);
    const rows = (await (db.from("manager_payees") as unknown as PromiseLike<{ data: Row[] }>).then((r) => r.data));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ manager_user_id: MANAGER, name: "Chase", account_reference: "4821" });
  });

  it("refuses an invalid enum with 400 and writes nothing", async () => {
    const db = setup();
    expect((await POST(req({ kind: "other", payeeType: "casino", name: "X" }))).status).toBe(400);
    expect((await POST(req({ kind: "other", payeeType: "utility", name: "X", payMethod: "crypto" }))).status).toBe(400);
    expect((await POST(req({ kind: "bank", name: "X" }))).status).toBe(400);
    const rows = await (db.from("manager_payees") as unknown as PromiseLike<{ data: Row[] }>).then((r) => r.data);
    expect(rows).toHaveLength(0);
  });

  it("refuses a teammate who is not on this manager's team", async () => {
    setup({ account_link_invites: [{ id: "l1", inviter_user_id: OTHER_MANAGER, invitee_user_id: STRANGER, status: "accepted" }] });
    const res = await POST(req({ kind: "teammate", teammateUserId: STRANGER, name: "Stranger" }));
    expect(res.status).toBe(404);
  });

  it("refuses a teammate whose link was never accepted", async () => {
    setup({ account_link_invites: [{ id: "l1", inviter_user_id: MANAGER, invitee_user_id: TEAMMATE, status: "pending" }] });
    expect((await POST(req({ kind: "teammate", teammateUserId: TEAMMATE, name: "Jordan" }))).status).toBe(404);
  });

  it("saves a teammate who is on the team, naming them from the team, not the request", async () => {
    setup({
      account_link_invites: [{ id: "l1", inviter_user_id: MANAGER, invitee_user_id: TEAMMATE, status: "accepted", invitee_display_name: "Jordan Lee" }],
      profiles: [{ id: TEAMMATE, full_name: "Jordan Lee", email: "j@example.com" }],
    });
    const res = await POST(req({ kind: "teammate", teammateUserId: TEAMMATE, name: "Totally Someone Else" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { payee: { name: string } }).payee.name).toBe("Jordan Lee");
  });

  it("refuses to update or archive another manager's payee", async () => {
    setup({ manager_payees: [payee(THEIRS, OTHER_MANAGER)] });
    expect((await PATCH(req({ id: THEIRS, name: "Mine now" }, "PATCH"))).status).toBe(404);
    expect((await PATCH(req({ id: THEIRS, archived: true }, "PATCH"))).status).toBe(404);
  });

  it("updates details and archives an owned payee", async () => {
    const db = setup({ manager_payees: [payee(MINE, MANAGER)] });
    const updated = await PATCH(req({ id: MINE, phone: "555-0100" }, "PATCH"));
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { payee: { phone: string } }).payee.phone).toBe("555-0100");
    expect((await PATCH(req({ id: MINE, archived: true }, "PATCH"))).status).toBe(200);
    const rows = await (db.from("manager_payees") as unknown as PromiseLike<{ data: Row[] }>).then((r) => r.data);
    expect(rows[0]!.archived_at).toBeTruthy();
  });
});

describe("POST /api/expenses with payeeId", () => {
  const body = (extra: Row = {}) =>
    new Request("http://localhost/api/expenses", {
      method: "POST",
      body: JSON.stringify({ categoryCode: "mortgage", amountCents: 214000, expenseDate: "2026-10-01", ...extra }),
    });

  it("records the payee on the expense when it is the manager's own", async () => {
    const db = setup({ manager_payees: [payee(MINE, MANAGER)] });
    const res = await EXPENSE_POST(body({ payeeId: MINE }));
    expect(res.status).toBe(200);
    const rows = await (db.from("manager_expense_entries") as unknown as PromiseLike<{ data: Row[] }>).then((r) => r.data);
    expect(rows[0]).toMatchObject({ manager_user_id: MANAGER, payee_id: MINE });
  });

  it("refuses another manager's payee id with 404 and writes no expense", async () => {
    const db = setup({ manager_payees: [payee(THEIRS, OTHER_MANAGER)] });
    const res = await EXPENSE_POST(body({ payeeId: THEIRS }));
    expect(res.status).toBe(404);
    const rows = await (db.from("manager_expense_entries") as unknown as PromiseLike<{ data: Row[] }>).then((r) => r.data);
    expect(rows).toHaveLength(0);
  });

  it("refuses an archived payee and a missing one the same way", async () => {
    setup({ manager_payees: [payee(ARCHIVED, MANAGER, { archived_at: "2026-01-01T00:00:00Z" })] });
    expect((await EXPENSE_POST(body({ payeeId: ARCHIVED }))).status).toBe(404);
    expect((await EXPENSE_POST(body({ payeeId: ABSENT }))).status).toBe(404);
  });

  it("still records an expense with no payee", async () => {
    setup();
    expect((await EXPENSE_POST(body())).status).toBe(200);
  });
});
