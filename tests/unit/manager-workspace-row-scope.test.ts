import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch A of the active-workspace scoping project: the shared record loader
 * behind charges/payments, service requests, and work orders
 * (`fetchRowsForManagerWithLinked`, `resolveManagerWorkspaceRowScope`,
 * `rowInWorkspaceScope`, `workspaceRowFilterClause` — all in
 * `@/lib/auth/co-manager-module-scope`).
 *
 * These exercise the shared loader directly with a real (fake) `loadWorkspaces`
 * resolution, rather than mocking it away, so a regression in either half — the
 * workspace resolution or the row-scoping predicate — fails a test here. Every
 * `it` below FAILS against pre-fix code (verified by stashing the source
 * changes and re-running; see the batch report).
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (_name: string) => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined),
  })),
}));

import {
  fetchRowsForManagerWithLinked,
  resolveManagerWorkspaceRowScope,
  rowInWorkspaceScope,
  workspaceRowFilterClause,
} from "@/lib/auth/co-manager-module-scope";

type Row = Record<string, unknown>;

/** Splits a PostgREST `or()`/`and()` expression on top-level commas only. */
function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** A pure matcher for the small PostgREST filter-string grammar this file's
 * code paths (`loadWorkspaces`, `linkedOwnerScopeForModule`, and
 * `workspaceRowFilterClause`'s own output) actually issue. */
function matchClause(expr: string): (row: Row) => boolean {
  const trimmed = expr.trim();
  const andMatch = trimmed.match(/^and\((.*)\)$/);
  if (andMatch) {
    const subs = splitTopLevel(andMatch[1]).map(matchClause);
    return (row) => subs.every((m) => m(row));
  }
  const orMatch = trimmed.match(/^or\((.*)\)$/);
  if (orMatch) {
    const subs = splitTopLevel(orMatch[1]).map(matchClause);
    return (row) => subs.some((m) => m(row));
  }
  const inMatch = trimmed.match(/^(\w+)\.in\.\(([^)]*)\)$/);
  if (inMatch) {
    const [, col, list] = inMatch;
    const vals = list
      .split(",")
      .map((v) => v.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    return (row) => vals.includes(String(row[col]));
  }
  const isNullMatch = trimmed.match(/^(\w+)\.is\.null$/);
  if (isNullMatch) {
    const [, col] = isNullMatch;
    return (row) => row[col] === null || row[col] === undefined;
  }
  const eqMatch = trimmed.match(/^(\w+)\.eq\.(.+)$/);
  if (eqMatch) {
    const [, col, val] = eqMatch;
    return (row) => String(row[col]) === val;
  }
  throw new Error(`unhandled clause: ${expr}`);
}

/** A top-level `.or(expr)` argument is an implicit OR of its top-level comma list. */
function buildOrMatcher(expr: string): (row: Row) => boolean {
  const subs = splitTopLevel(expr).map(matchClause);
  return (row) => subs.some((m) => m(row));
}

function fakeTable(rows: Row[]) {
  let current = [...rows];
  const builder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      current = current.filter((r) => r[col] === val);
      return builder;
    },
    in(col: string, vals: readonly unknown[]) {
      const set = new Set(vals);
      current = current.filter((r) => set.has(r[col] as never));
      return builder;
    },
    not(col: string, op: string, val: unknown) {
      if (op === "is" && val === null) current = current.filter((r) => r[col] !== null && r[col] !== undefined);
      return builder;
    },
    or(expr: string) {
      current = current.filter(buildOrMatcher(expr));
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    range: async (from: number, to: number) => ({ data: current.slice(from, to + 1), error: null }),
    maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve({ data: current, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

type Fixture = {
  profiles: Row[];
  accountLinkInvites: Row[];
  managerPropertyRecords: Row[];
  portalWorkspaces: Row[];
  /** The table `fetchRowsForManagerWithLinked` is fetching from in this test. */
  rows: Row[];
};

const TABLE = "portal_household_charge_records";

function fakeDb(data: Fixture): SupabaseClient {
  return {
    from(table: string) {
      switch (table) {
        case "profiles":
          return fakeTable(data.profiles);
        case "account_link_invites":
          return fakeTable(data.accountLinkInvites);
        case "manager_property_records":
          return fakeTable(data.managerPropertyRecords);
        case "portal_workspaces":
          return fakeTable(data.portalWorkspaces);
        case TABLE:
          return fakeTable(data.rows);
        default:
          throw new Error(`unexpected table: ${table}`);
      }
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  state.cookieValue = undefined;
});

describe("workspaceRowFilterClause — pure predicate string", () => {
  it("returns a single `.in()` clause for a non-empty workspace with no default-visible rows", () => {
    expect(workspaceRowFilterClause(["property_id"], ["p1", "p2"], false)).toBe('property_id.in.("p1","p2")');
  });

  it("adds an `.is.null` branch, wrapped in or(), when untagged rows are visible", () => {
    expect(workspaceRowFilterClause(["property_id"], ["p1"], true)).toBe('or(property_id.in.("p1"),property_id.is.null)');
  });

  it("ANDs every property column's null check for a multi-column table", () => {
    expect(workspaceRowFilterClause(["property_id", "assigned_property_id"], [], true)).toBe(
      "and(property_id.is.null,assigned_property_id.is.null)",
    );
  });

  it("returns null (skip the query) when an empty workspace has no default-visible rows either", () => {
    expect(workspaceRowFilterClause(["property_id"], [], false)).toBeNull();
  });
});

describe("rowInWorkspaceScope — pure narrowing check", () => {
  const scope = { propertyIds: ["p1"], untaggedOwnedVisible: true };

  it("never narrows when the scope did not resolve", () => {
    expect(rowInWorkspaceScope("anything", { propertyIds: null, untaggedOwnedVisible: false })).toBe(true);
    expect(rowInWorkspaceScope(null, { propertyIds: null, untaggedOwnedVisible: false })).toBe(true);
  });

  it("matches a property in the workspace", () => {
    expect(rowInWorkspaceScope("p1", scope)).toBe(true);
  });

  it("refuses a property outside the workspace", () => {
    expect(rowInWorkspaceScope("p2", scope)).toBe(false);
  });

  it("follows untaggedOwnedVisible for a row with no property", () => {
    expect(rowInWorkspaceScope(null, scope)).toBe(true);
    expect(rowInWorkspaceScope(null, { propertyIds: ["p1"], untaggedOwnedVisible: false })).toBe(false);
  });
});

const MANAGER = "mgr-multi";
const WS_A = "ws-a";
const WS_B = "ws-b";
const WS_EMPTY = "ws-empty";

function multiWorkspaceFixture(): Fixture {
  return {
    profiles: [{ id: MANAGER, email: "multi@test.local" }],
    accountLinkInvites: [],
    portalWorkspaces: [
      { id: WS_A, name: "A", owner_user_id: MANAGER, is_default: true },
      { id: WS_B, name: "B", owner_user_id: MANAGER, is_default: false },
      { id: WS_EMPTY, name: "Empty", owner_user_id: MANAGER, is_default: false },
    ],
    managerPropertyRecords: [
      { id: "prop-a", manager_user_id: MANAGER, workspace_id: WS_A, row_data: {}, status: "live" },
      { id: "prop-b", manager_user_id: MANAGER, workspace_id: WS_B, row_data: {}, status: "live" },
    ],
    rows: [
      { id: "row-a", manager_user_id: MANAGER, property_id: "prop-a", row_data: {}, updated_at: "2026-01-01" },
      { id: "row-b", manager_user_id: MANAGER, property_id: "prop-b", row_data: {}, updated_at: "2026-01-01" },
      // Account-level: no house, e.g. a manual one-off charge.
      { id: "row-none", manager_user_id: MANAGER, property_id: null, row_data: {}, updated_at: "2026-01-01" },
    ],
  };
}

describe("fetchRowsForManagerWithLinked — active-workspace narrowing of a manager's own rows", () => {
  it("shows only workspace A's rows, plus the account-level row, while A (the default) is active", async () => {
    const db = fakeDb(multiWorkspaceFixture());
    state.cookieValue = WS_A;
    const scope = await resolveManagerWorkspaceRowScope(db, MANAGER);
    expect(scope.propertyIds).toEqual(["prop-a"]);
    expect(scope.untaggedOwnedVisible).toBe(true);

    const rows = await fetchRowsForManagerWithLinked<{ id: string }>(db, TABLE, MANAGER, new Set(), {
      propertyColumns: ["property_id"],
      workspaceScope: scope,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["row-a", "row-none"]);
  });

  it("shows only workspace B's rows — no account-level row — once B is active", async () => {
    const db = fakeDb(multiWorkspaceFixture());
    state.cookieValue = WS_B;
    const scope = await resolveManagerWorkspaceRowScope(db, MANAGER);
    expect(scope.propertyIds).toEqual(["prop-b"]);
    // B is owned but not the default workspace, so the no-house row stays hidden.
    expect(scope.untaggedOwnedVisible).toBe(false);

    const rows = await fetchRowsForManagerWithLinked<{ id: string }>(db, TABLE, MANAGER, new Set(), {
      propertyColumns: ["property_id"],
      workspaceScope: scope,
    });
    expect(rows.map((r) => r.id)).toEqual(["row-b"]);
  });

  it("returns NO rows — not every row — for a workspace holding zero houses", async () => {
    const db = fakeDb(multiWorkspaceFixture());
    state.cookieValue = WS_EMPTY;
    const scope = await resolveManagerWorkspaceRowScope(db, MANAGER);
    expect(scope.propertyIds).toEqual([]);
    expect(scope.untaggedOwnedVisible).toBe(false);

    const rows = await fetchRowsForManagerWithLinked<{ id: string }>(db, TABLE, MANAGER, new Set(), {
      propertyColumns: ["property_id"],
      workspaceScope: scope,
    });
    expect(rows).toEqual([]);
  });

  it("leaves a single-workspace manager's read unaffected — every one of their rows still shows", async () => {
    const SOLO = "mgr-solo";
    const WS_SOLO = "ws-solo";
    const db = fakeDb({
      profiles: [{ id: SOLO, email: "solo@test.local" }],
      accountLinkInvites: [],
      portalWorkspaces: [{ id: WS_SOLO, name: "Solo", owner_user_id: SOLO, is_default: true }],
      managerPropertyRecords: [
        { id: "prop-solo-1", manager_user_id: SOLO, workspace_id: WS_SOLO, row_data: {}, status: "live" },
        { id: "prop-solo-2", manager_user_id: SOLO, workspace_id: WS_SOLO, row_data: {}, status: "live" },
      ],
      rows: [
        { id: "row-solo-1", manager_user_id: SOLO, property_id: "prop-solo-1", row_data: {}, updated_at: "2026-01-01" },
        { id: "row-solo-2", manager_user_id: SOLO, property_id: "prop-solo-2", row_data: {}, updated_at: "2026-01-01" },
        { id: "row-solo-none", manager_user_id: SOLO, property_id: null, row_data: {}, updated_at: "2026-01-01" },
      ],
    });
    const scope = await resolveManagerWorkspaceRowScope(db, SOLO);
    const rows = await fetchRowsForManagerWithLinked<{ id: string }>(db, TABLE, SOLO, new Set(), {
      propertyColumns: ["property_id"],
      workspaceScope: scope,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["row-solo-1", "row-solo-2", "row-solo-none"]);
  });
});

const VIEWER = "viewer-co-manager";
const OWNER_A = "owner-a";
const WS_VIEWER = "ws-viewer";
const WS_A2 = "ws-a2";

/** A co-manager (VIEWER) holds a `payments` grant on owner A's `house-a1` only — never `house-a2`. */
function coManagerFixture(): Fixture {
  return {
    profiles: [
      { id: VIEWER, email: "viewer@test.local" },
      { id: OWNER_A, email: "ownera@test.local" },
    ],
    portalWorkspaces: [
      { id: WS_VIEWER, name: "Viewer workspace", owner_user_id: VIEWER, is_default: true },
      { id: WS_A2, name: "Owner A workspace", owner_user_id: OWNER_A, is_default: true },
    ],
    accountLinkInvites: [
      {
        id: "invite-a-to-viewer",
        inviter_user_id: OWNER_A,
        invitee_user_id: VIEWER,
        invitee_display_name: "Viewer",
        assigned_property_ids: ["house-a1"],
        property_co_manager_permissions: { "house-a1": { payments: { read: true } } },
        co_manager_permissions: null,
        workspace_id: null,
        workspace_permissions: null,
        legacy_workspace_permissions: null,
        team_role: null,
        house_scope: "selected",
        status: "accepted",
        responded_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    managerPropertyRecords: [
      { id: "house-viewer", manager_user_id: VIEWER, workspace_id: WS_VIEWER, row_data: {}, status: "live" },
      { id: "house-a1", manager_user_id: OWNER_A, workspace_id: WS_A2, row_data: {}, status: "live" },
      { id: "house-a2", manager_user_id: OWNER_A, workspace_id: WS_A2, row_data: {}, status: "live" },
    ],
    rows: [
      { id: "row-viewer", manager_user_id: VIEWER, property_id: "house-viewer", row_data: {}, updated_at: "2026-01-01" },
      { id: "row-a1", manager_user_id: OWNER_A, property_id: "house-a1", row_data: {}, updated_at: "2026-01-01" },
      { id: "row-a2", manager_user_id: OWNER_A, property_id: "house-a2", row_data: {}, updated_at: "2026-01-01" },
    ],
  };
}

describe("fetchRowsForManagerWithLinked — a co-manager's granted house reachable only in the workspace that holds it", () => {
  it("hides owner A's granted house while the co-manager's OWN workspace is active", async () => {
    const db = fakeDb(coManagerFixture());
    state.cookieValue = WS_VIEWER;
    const scope = await resolveManagerWorkspaceRowScope(db, VIEWER);
    expect(scope.propertyIds).toEqual(["house-viewer"]);

    const rows = await fetchRowsForManagerWithLinked<{ id: string }>(
      db,
      TABLE,
      VIEWER,
      new Set(["house-a1"]), // the module grant, resolved independently of workspace
      { propertyColumns: ["property_id"], workspaceScope: scope },
    );
    expect(rows.map((r) => r.id)).toEqual(["row-viewer"]);
  });

  it("shows exactly the granted house, never the ungranted one, once owner A's shared workspace is active", async () => {
    const db = fakeDb(coManagerFixture());
    state.cookieValue = WS_A2;
    const scope = await resolveManagerWorkspaceRowScope(db, VIEWER);
    expect(scope.propertyIds).toEqual(["house-a1"]);

    const rows = await fetchRowsForManagerWithLinked<{ id: string }>(
      db,
      TABLE,
      VIEWER,
      new Set(["house-a1"]),
      { propertyColumns: ["property_id"], workspaceScope: scope },
    );
    expect(rows.map((r) => r.id)).toEqual(["row-a1"]);
  });
});

describe("fetchRowsForManagerWithLinked — omitting workspaceScope preserves prior behavior", () => {
  it("returns every owned row, unnarrowed, for a caller that has not opted in (e.g. the attention digest)", async () => {
    const db = fakeDb(multiWorkspaceFixture());
    const rows = await fetchRowsForManagerWithLinked<{ id: string }>(db, TABLE, MANAGER, new Set(), {
      propertyColumns: ["property_id"],
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["row-a", "row-b", "row-none"]);
  });
});
