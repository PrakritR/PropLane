import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bug: src/lib/portal-record-api.ts's shared upsert path unconditionally
 * selected `manager_user_id` for EVERY table using createJsonRecordRoute,
 * before checking whether a row already exists. portal_bug_feedback_records
 * (migration 20260622120000) has never had that column — only
 * reporter_user_id — so the select 500s at the database level for any
 * bug/feedback submission. Commit aee8c7a15a (2026-09-02).
 *
 * This fake Supabase client enforces the same column-existence rule a real
 * Postgres/PostgREST database would: a select naming a column outside the
 * table's actual schema errors, exactly like the live bug did. Before the
 * fix (an unconditional "id, manager_user_id, row_data" select), the first
 * test below fails because that select is rejected; after the fix (a
 * per-table configurable select, defaulting to "id, row_data" and never
 * naming a column the table doesn't have), it passes.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  portal: {
    user: { id: "manager-1", email: "manager2@test.proplane.local" },
    roles: ["manager"],
    effectiveRole: "manager",
    profile: { email: "manager2@test.proplane.local", role: "manager" },
  } as Record<string, unknown>,
  admin: false,
  rows: [] as Row[],
}));

// portal_bug_feedback_records' real, actual columns (20260622120000_portal_bug_feedback_records.sql).
// Notably absent: manager_user_id.
const BUG_FEEDBACK_COLUMNS = new Set([
  "id",
  "reporter_user_id",
  "reporter_email",
  "reporter_role",
  "report_type",
  "row_data",
  "created_at",
  "updated_at",
]);

vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => state.portal }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => state.admin }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ from: (table: string) => query(table) }),
}));

function parseSelectColumns(select: string): string[] {
  return select
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

function query(table: string) {
  const filters: Record<string, unknown> = {};
  let pendingSelect: string | null = null;
  let deleting = false;
  const chain: Record<string, unknown> = {};

  function matches(row: Row): boolean {
    for (const [col, val] of Object.entries(filters)) {
      if (col === "limit" || col === "scope") continue;
      if (row[col] !== val) return false;
    }
    if (filters.scope) {
      const email = (state.portal.user as { email?: string }).email;
      const id = (state.portal.user as { id: string }).id;
      if (row.reporter_user_id !== id && row.reporter_email !== email) return false;
    }
    return true;
  }

  function rowsFor(): Row[] {
    const source = table === "portal_bug_feedback_records" ? state.rows : [];
    const filtered = source.filter((row) => matches(row));
    return typeof filters.limit === "number" ? filtered.slice(0, filters.limit as number) : filtered;
  }

  Object.assign(chain, {
    select: (cols: string) => {
      pendingSelect = cols;
      return chain;
    },
    order: () => chain,
    limit: (n: number) => {
      filters.limit = n;
      return chain;
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    },
    or: () => {
      filters.scope = true;
      return chain;
    },
    delete: () => {
      deleting = true;
      return chain;
    },
    upsert: async (row: Row) => {
      state.rows = [...state.rows.filter((r) => r.id !== row.id), row];
      return { error: null };
    },
    then: (resolve: (value: { data: Row[] | null; error: { message: string } | null }) => unknown) => {
      // Simulate a real database: a select naming a column this table's
      // schema does not have errors, exactly like the live 500.
      if (table === "portal_bug_feedback_records" && pendingSelect) {
        const unknownColumn = parseSelectColumns(pendingSelect).find(
          (col) => col !== "*" && !BUG_FEEDBACK_COLUMNS.has(col),
        );
        if (unknownColumn) {
          return resolve({
            data: null,
            error: { message: `column portal_bug_feedback_records.${unknownColumn} does not exist` },
          });
        }
      }
      const rows = rowsFor();
      if (deleting) {
        const ids = new Set(rows.map((row) => String(row.id)));
        state.rows = state.rows.filter((row) => !ids.has(String(row.id)));
        return resolve({ data: rows.map((row) => ({ id: row.id })), error: null });
      }
      return resolve({ data: rows, error: null });
    },
  });
  return chain;
}

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/portal-bug-feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.admin = false;
  state.rows = [];
  state.portal = {
    user: { id: "manager-1", email: "manager2@test.proplane.local" },
    roles: ["manager"],
    effectiveRole: "manager",
    profile: { email: "manager2@test.proplane.local", role: "manager" },
  };
});

describe("portal-record-api: existing-row select never names a column the table lacks", () => {
  it("submitting new feedback does not 500 on the existing-row check for portal_bug_feedback_records", async () => {
    const { POST } = await import("@/app/api/portal-bug-feedback/route");
    const response = await POST(
      post({
        action: "upsert",
        row: { id: "bf-select-guard", type: "bug", title: "Broken button", description: "Cannot save" },
      }),
    );
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBeUndefined();
    expect(response.status).toBe(200);
  });
});

describe("portal-bug-feedback route: feedback submit", () => {
  it("submits a new bug/feedback report and lists it back via GET", async () => {
    const { POST, GET } = await import("@/app/api/portal-bug-feedback/route");
    const response = await POST(
      post({
        action: "upsert",
        row: {
          id: "bf-proof-1",
          type: "bug",
          reportKind: "bug",
          title: "Need help panel",
          description: "Submitting through the redesigned form",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(state.rows).toHaveLength(1);

    const listed = (await (await GET()).json()) as { rows: Row[] };
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]!.id).toBe("bf-proof-1");
  });

  it("attributes the row's ownership to the authenticated user and ignores a body-supplied reporter id (ids in a request body are not authorization)", async () => {
    const { POST } = await import("@/app/api/portal-bug-feedback/route");
    const response = await POST(
      post({
        action: "upsert",
        row: {
          id: "bf-proof-2",
          type: "bug",
          title: "Spoofed owner attempt",
          description: "Body claims to be someone else",
          reporterUserId: "someone-elses-id",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(state.rows).toHaveLength(1);
    const stored = state.rows[0]!;
    // The ownership id the scope check and admin attribution rely on is
    // always the authenticated caller's id, never the body's claim.
    expect(stored.reporter_user_id).toBe("manager-1");
  });

  it("admin can still read another reporter's feedback, but a manager cannot read past their own scope", async () => {
    state.rows = [
      { id: "bf-mine", reporter_user_id: "manager-1", reporter_email: "manager2@test.proplane.local", reporter_role: "manager", report_type: "bug", row_data: { id: "bf-mine" }, created_at: "now", updated_at: "now" },
      { id: "bf-someone-elses", reporter_user_id: "other-user", reporter_email: "other@test.proplane.local", reporter_role: "manager", report_type: "bug", row_data: { id: "bf-someone-elses" }, created_at: "now", updated_at: "now" },
    ];
    const { GET } = await import("@/app/api/portal-bug-feedback/route");
    const mine = (await (await GET()).json()) as { rows: Row[] };
    expect(mine.rows.map((r) => r.id)).toEqual(["bf-mine"]);

    state.admin = true;
    state.portal = {
      user: { id: "admin-1", email: "admin@test.proplane.local" },
      roles: ["admin"],
      effectiveRole: "admin",
      profile: { email: "admin@test.proplane.local", role: "admin" },
    };
    const asAdmin = (await (await GET()).json()) as { rows: Row[] };
    expect(asAdmin.rows.map((r) => r.id).sort()).toEqual(["bf-mine", "bf-someone-elses"]);
  });
});

describe("portal-record-api: empty replace", () => {
  it("returns 200 { ok, upserted: 0 } for replace with no rows, still 400 for upsert without a row", async () => {
    const { POST } = await import("@/app/api/portal-bug-feedback/route");
    const empty = await POST(post({ action: "replace", rows: [] }));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ ok: true, upserted: 0 });
    const missing = await POST(post({ action: "upsert" }));
    expect(missing.status).toBe(400);
  });
});
