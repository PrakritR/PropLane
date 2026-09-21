import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route coverage for GET /api/agent/pending-actions — the dashboard's read of
 * the manager's open AI drafts. Pins the security-critical scoping:
 *  - owner key is `user_id` (NOT `landlord_id`, which two residents of one
 *    manager share), plus `status = 'proposed'` and an unexpired `expires_at`;
 *  - the stored tool INPUT is never selected/returned — only the preview the
 *    manager already vetoes.
 */

type Filter = { kind: "eq" | "gt" | "is"; col: string; value: unknown };

let selectArg = "";
let filters: Filter[] = [];
const rows = [
  {
    id: "pa_1",
    tool_name: "send_rent_reminders",
    preview: { kind: "send_rent_reminders", title: "Rent reminder", confirmLabel: "Send", fields: [] },
    created_at: "2026-07-23T00:00:00.000Z",
  },
];

const fakeDb = {
  from() {
    return this;
  },
  select(arg: string) {
    selectArg = arg;
    return this;
  },
  eq(col: string, value: unknown) {
    filters.push({ kind: "eq", col, value });
    return this;
  },
  gt(col: string, value: unknown) {
    filters.push({ kind: "gt", col, value });
    return this;
  },
  is(col: string, value: unknown) {
    filters.push({ kind: "is", col, value });
    return this;
  },
  order() {
    return this;
  },
  limit() {
    return Promise.resolve({ data: rows, error: null });
  },
};

const resolveAgentContext = vi.fn();
vi.mock("@/lib/tools/context", () => ({
  resolveAgentContext: () => resolveAgentContext(),
}));

import { GET } from "@/app/api/agent/pending-actions/route";

beforeEach(() => {
  selectArg = "";
  filters = [];
  resolveAgentContext.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/agent/pending-actions", () => {
  it("401s when the caller is not an authenticated manager", async () => {
    resolveAgentContext.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("scopes by user_id + manager portal + proposed + unexpired and never returns the stored input", async () => {
    resolveAgentContext.mockResolvedValue({
      userId: "manager_a",
      landlordId: "manager_a",
      db: fakeDb,
    });

    const res = await GET();
    const body = (await res.json()) as { actions: Array<Record<string, unknown>> };

    // The select list is exactly the preview-facing columns — `input` is absent.
    expect(selectArg).toBe("id, tool_name, preview, created_at");
    expect(selectArg).not.toContain("input");

    // Owner key is user_id (not landlord_id), plus the proposed/unexpired guards.
    expect(filters).toContainEqual({ kind: "eq", col: "user_id", value: "manager_a" });
    expect(filters).toContainEqual({ kind: "eq", col: "status", value: "proposed" });
    // Portal-scoped: a dual-role user's resident/vendor proposals are only
    // confirmable from their own portal, so listing them as manager AI drafts
    // would offer an approval the portal-bound confirm gate must refuse.
    expect(filters).toContainEqual({ kind: "eq", col: "portal", value: "manager" });
    expect(filters.some((f) => f.col === "landlord_id")).toBe(false);
    expect(filters).toContainEqual({ kind: "is", col: "sms_test_actor_user_id", value: null });
    expect(filters).toContainEqual({ kind: "is", col: "sms_test_manager_user_id", value: null });
    expect(filters).toContainEqual({ kind: "is", col: "sms_test_session_id", value: null });
    expect(filters.some((f) => f.kind === "gt" && f.col === "expires_at")).toBe(true);

    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]!.id).toBe("pa_1");
    expect(body.actions[0]).not.toHaveProperty("input");
  });
});
