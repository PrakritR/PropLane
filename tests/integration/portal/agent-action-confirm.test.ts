import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/analytics/posthog", () => ({
  track: vi.fn(),
}));

vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: vi.fn().mockResolvedValue(false),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { track } from "@/lib/analytics/posthog";
import { POST as agentChat } from "@/app/api/agent/chat/route";

const MANAGER_ID = "11111111-1111-4111-8111-111111111111";
const STRANGER_ID = "22222222-2222-4222-8222-222222222222";
const ACTION_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Full propose→claim→execute round trip through the ONE confirm gate against an
 * in-memory stand-in for the service-role client: pending-action claim
 * semantics, audit_log write, and the anti-enumeration / expiry /
 * double-confirm paths. Runs the REAL manager registry (send_rent_reminder) so
 * the tool's ownership re-resolution is exercised, not mocked.
 *
 * The client posts ONLY the action id back to the same auth-gated chat endpoint
 * it proposed from; a claim that does not land is answered with a single 410
 * regardless of WHY (foreign / expired / already resolved), so the response can
 * never be used to enumerate other users' action ids.
 */

type Row = Record<string, unknown>;

function overdueCharge(id: string, managerUserId: string) {
  return {
    id,
    createdAt: "2026-06-01T00:00:00.000Z",
    residentEmail: "resident@axis.local", // demo address => portal_only delivery, no network
    residentName: "Pat Resident",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "12 Main St",
    managerUserId,
    kind: "rent",
    title: "Monthly rent",
    amountLabel: "$1,500.00",
    balanceLabel: "$1,500.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    dueDateLabel: "Jan 1, 2020",
  };
}

function makeFakeServiceDb(opts: {
  pendingRows: Row[];
  charges: ReturnType<typeof overdueCharge>[];
  residentProfile?: Row | false;
}) {
  const auditLog: Row[] = [];
  const inboxThreads: Row[] = [];
  const agentMessages: Row[] = [];

  function matches(row: Row, filters: [string, string, unknown][]): boolean {
    return filters.every(([op, col, val]) => {
      if (op === "eq") return row[col] === val;
      if (op === "gt") return String(row[col] ?? "") > String(val ?? "");
      return true;
    });
  }

  function chainFor(table: string) {
    const filters: [string, string, unknown][] = [];
    let pendingUpdate: Row | null = null;

    const rowsFor = (): Row[] => {
      if (table === "agent_pending_actions") return opts.pendingRows;
      if (table === "audit_log") return auditLog;
      return [];
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      insert: (values: Row | Row[]) => {
        if (table === "audit_log") {
          const row = values as Row;
          if (
            row.dedupe_key != null &&
            auditLog.some((r) => r.dedupe_key === row.dedupe_key)
          ) {
            return Promise.resolve({ error: { code: "23505", message: "duplicate" } });
          }
          auditLog.push({ ...row });
          return Promise.resolve({ error: null });
        }
        if (table === "agent_messages") {
          for (const row of Array.isArray(values) ? values : [values]) agentMessages.push({ ...row });
          return Promise.resolve({ error: null });
        }
        return Promise.resolve({ error: null });
      },
      upsert: (row: Row) => {
        if (table === "portal_inbox_thread_records") inboxThreads.push({ ...row });
        return Promise.resolve({ error: null });
      },
      update: (values: Row) => {
        pendingUpdate = values;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        filters.push(["eq", col, val]);
        return chain;
      },
      gt: (col: string, val: unknown) => {
        filters.push(["gt", col, val]);
        return chain;
      },
      maybeSingle: async () => {
        if (table === "profiles") {
          const emailFilter = filters.find(([, col]) => col === "email");
          if (emailFilter) {
            const profile = opts.residentProfile === false
              ? null
              : opts.residentProfile ?? {
                  id: "44444444-4444-4444-8444-444444444444",
                  email: emailFilter[2],
                  role: "resident",
                  phone: null,
                  phone_verified_at: null,
                };
            return { data: profile, error: null };
          }
          return { data: { email: "manager@axis.test", role: "manager" }, error: null };
        }
        const hit = rowsFor().find((r) => matches(r, filters));
        if (!hit) return { data: null, error: null };
        if (pendingUpdate) Object.assign(hit, pendingUpdate);
        return { data: { ...hit }, error: null };
      },
      range: async (from: number, to: number) => {
        if (table === "portal_household_charge_records") {
          const page = opts.charges.slice(from, to + 1).map((c) => ({ row_data: c }));
          return { data: page, error: null };
        }
        return { data: [], error: null };
      },
      // awaiting the chain directly (profile_roles select, the claim's
      // update(...).select(...), audit update .eq)
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        if (pendingUpdate) {
          const hits = rowsFor().filter((r) => matches(r, filters));
          for (const r of hits) Object.assign(r, pendingUpdate);
          return Promise.resolve({ data: hits.map((r) => ({ ...r })), error: null }).then(resolve);
        }
        if (table === "profile_roles") {
          return Promise.resolve({ data: [{ role: "manager" }] as Row[], error: null }).then(resolve);
        }
        return Promise.resolve({ data: rowsFor().filter((r) => matches(r, filters)), error: null }).then(resolve);
      },
    };
    return chain;
  }

  const db = { from: (table: string) => chainFor(table) };
  return { db, auditLog, inboxThreads, agentMessages };
}

function mockAuthUser(userId: string | null) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId, email: "manager@axis.test" } : null },
      }),
    },
  } as never);
}

function pendingRow(overrides: Row = {}): Row {
  return {
    id: ACTION_ID,
    user_id: MANAGER_ID,
    portal: "manager",
    landlord_id: MANAGER_ID,
    session_id: null,
    tool_name: "send_rent_reminder",
    input: { chargeIds: ["hc_1"] },
    preview: { kind: "send_rent_reminder", title: "Send rent reminder", confirmLabel: "Send", fields: [] },
    status: "proposed",
    created_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    resolved_at: null,
    ...overrides,
  };
}

function actionRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("agent confirm gate (POST /api/agent/chat)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESEND_API_KEY;
  });

  it("confirms a pending action: claims it, executes the tool, writes the audit row", async () => {
    mockAuthUser(MANAGER_ID);
    const rows = [pendingRow()];
    const fake = makeFakeServiceDb({ pendingRows: rows, charges: [overdueCharge("hc_1", MANAGER_ID)] });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fake.db as never);

    const res = await agentChat(actionRequest({ confirmActionId: ACTION_ID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string };
    expect(body.reply.toLowerCase()).toContain("portal");

    expect(rows[0]!.status).toBe("executed");
    expect(fake.auditLog).toHaveLength(1);
    expect(String(fake.auditLog[0]!.dedupe_key)).toContain(`send_rent_reminder:${MANAGER_ID}:hc_1`);
    expect(vi.mocked(track)).toHaveBeenCalledWith(
      "assistant_action_confirmed",
      MANAGER_ID,
      expect.objectContaining({ action: "send_rent_reminder", portal: "manager" }),
    );
  });

  it("clears the reminder dedupe key when every requested channel is unavailable", async () => {
    mockAuthUser(MANAGER_ID);
    const rows = [pendingRow()];
    const fake = makeFakeServiceDb({
      pendingRows: rows,
      charges: [overdueCharge("hc_1", MANAGER_ID)],
      residentProfile: false,
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fake.db as never);

    const res = await agentChat(actionRequest({ confirmActionId: ACTION_ID }));
    expect(res.status).toBe(200);
    expect(fake.auditLog).toHaveLength(1);
    expect(fake.auditLog[0]!.dedupe_key).toBeNull();
    expect((fake.auditLog[0]!.result_summary as { delivery?: unknown })?.delivery).toEqual({
      portal: "skipped",
      email: "skipped",
      sms: "skipped",
    });
  });

  it("cancel records the decision without executing anything", async () => {
    mockAuthUser(MANAGER_ID);
    const rows = [pendingRow()];
    const fake = makeFakeServiceDb({ pendingRows: rows, charges: [overdueCharge("hc_1", MANAGER_ID)] });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fake.db as never);

    const res = await agentChat(actionRequest({ denyActionId: ACTION_ID }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: string }).reply).toMatch(/cancelled/i);
    expect(rows[0]!.status).toBe("denied");
    expect(fake.auditLog).toHaveLength(0);
    expect(vi.mocked(track)).toHaveBeenCalledWith(
      "assistant_action_denied",
      MANAGER_ID,
      expect.objectContaining({ portal: "manager", known: true }),
    );
  });

  it("a second confirm of the same action returns 409 and does not execute twice", async () => {
    mockAuthUser(MANAGER_ID);
    const rows = [pendingRow()];
    const fake = makeFakeServiceDb({ pendingRows: rows, charges: [overdueCharge("hc_1", MANAGER_ID)] });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fake.db as never);

    const first = await agentChat(actionRequest({ confirmActionId: ACTION_ID }));
    expect(first.status).toBe(200);
    const second = await agentChat(actionRequest({ confirmActionId: ACTION_ID }));
    expect(second.status).toBe(410);
    expect(fake.auditLog).toHaveLength(1);
  });

  it("a foreign user's confirm reads the same as any other dead id (anti-enumeration) and executes nothing", async () => {
    mockAuthUser(STRANGER_ID);
    const rows = [pendingRow()];
    const fake = makeFakeServiceDb({ pendingRows: rows, charges: [overdueCharge("hc_1", MANAGER_ID)] });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fake.db as never);

    const res = await agentChat(actionRequest({ confirmActionId: ACTION_ID }));
    expect(res.status).toBe(410);
    expect(rows[0]!.status).toBe("proposed");
    expect(fake.auditLog).toHaveLength(0);
  });

  it("an expired action returns 410", async () => {
    mockAuthUser(MANAGER_ID);
    const rows = [pendingRow({ expires_at: new Date(Date.now() - 1000).toISOString() })];
    const fake = makeFakeServiceDb({ pendingRows: rows, charges: [overdueCharge("hc_1", MANAGER_ID)] });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fake.db as never);

    const res = await agentChat(actionRequest({ confirmActionId: ACTION_ID }));
    expect(res.status).toBe(410);
    expect(fake.auditLog).toHaveLength(0);
  });

  it("unauthenticated requests get 401", async () => {
    mockAuthUser(null);
    const res = await agentChat(actionRequest({ confirmActionId: ACTION_ID }));
    expect(res.status).toBe(401);
  });

  it("execute re-resolves ownership: a stored input targeting a charge that is no longer overdue reports it", async () => {
    mockAuthUser(MANAGER_ID);
    const rows = [pendingRow({ input: { chargeIds: ["hc_gone"] } })];
    const fake = makeFakeServiceDb({ pendingRows: rows, charges: [overdueCharge("hc_1", MANAGER_ID)] });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fake.db as never);

    const res = await agentChat(actionRequest({ confirmActionId: ACTION_ID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string };
    expect(body.reply.toLowerCase()).toContain("no longer overdue and skipped");
    expect(fake.auditLog).toHaveLength(0);
  });
});
