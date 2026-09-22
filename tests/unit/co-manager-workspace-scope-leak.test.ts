import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Regression coverage for the cross-workspace Communication leak: a co-manager
 * who accepted an invite to ANOTHER owner's house could see that owner's
 * threads while their OWN single workspace was active, because
 * `resolveCommunicationScope` / `activeWorkspacePropertyScope` skipped
 * narrowing entirely whenever `loadWorkspaces` returned <= 1 workspace.
 *
 * In practice that single-workspace state is reached precisely when the
 * granted property's own `manager_property_records` row predates the
 * workspace_id column (a NULL `workspace_id`): `loadWorkspaces` could not
 * attribute the property to ANY workspace, so no shared workspace ever
 * appeared for the viewer, and their account looked like an ordinary
 * single-workspace account — the exact precondition the (now removed)
 * `workspaces.length <= 1` skip degraded to "grant check alone".
 *
 * These exercise the real, DB-driven resolvers end to end (not just the pure
 * `conversationVisible` decision already covered by
 * `communication-visibility.test.ts`, whose `scope()` fixture helper this
 * reuses conceptually for the assertions below).
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (_name: string) => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined),
  })),
}));

import { conversationVisible, resolveCommunicationScope } from "@/lib/communication/conversation-visibility.server";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";

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

/** Just enough of PostgREST's `or()` grammar for the two shapes `loadWorkspaces` issues. */
function buildOrMatcher(expr: string): (row: Row) => boolean {
  const matchers = splitTopLevel(expr).map((clause) => {
    const inMatch = clause.match(/^(\w+)\.in\.\(([^)]*)\)$/);
    if (inMatch) {
      const [, col, list] = inMatch;
      const vals = list.split(",").map((v) => v.trim()).filter(Boolean);
      return (row: Row) => vals.includes(String(row[col]));
    }
    const andMatch = clause.match(/^and\((.*)\)$/);
    if (andMatch) {
      const subMatchers = splitTopLevel(andMatch[1]).map((sub) => {
        const eqMatch = sub.match(/^(\w+)\.eq\.(.+)$/);
        if (eqMatch) {
          const [, col, val] = eqMatch;
          return (row: Row) => String(row[col]) === val;
        }
        const isNullMatch = sub.match(/^(\w+)\.is\.null$/);
        if (isNullMatch) {
          const [, col] = isNullMatch;
          return (row: Row) => row[col] === null || row[col] === undefined;
        }
        throw new Error(`unhandled and-clause: ${sub}`);
      });
      return (row: Row) => subMatchers.every((m) => m(row));
    }
    throw new Error(`unhandled or-clause: ${clause}`);
  });
  return (row: Row) => matchers.some((m) => m(row));
}

/**
 * A minimal thenable query-builder stub covering the exact chain shapes
 * `loadWorkspaces` and `linkedOwnerScopeForModule` issue. Each `.from()` call
 * gets its own filtered copy of the fixture rows, so repeated reads of the
 * same table within one resolution never cross-contaminate.
 */
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
};

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
        // Work-identity tables `resolveCommunicationScope` also reads while
        // narrowing; no fixture in this file needs a shared work line.
        case "manager_sms_numbers":
        case "manager_assistant_emails":
        case "workspace_work_numbers":
          return fakeTable([]);
        default:
          throw new Error(`unexpected table: ${table}`);
      }
    },
  } as unknown as SupabaseClient;
}

const VIEWER = "viewer-co-manager";
const OWNER_A = "owner-a";
const SOLO = "solo-owner";

const WS_VIEWER = "ws-viewer";
const WS_A = "ws-a";
const WS_SOLO = "ws-solo";

/**
 * The reported shape: OWNER_A granted VIEWER `inbox` read on `house-a1`, but
 * that property's own record predates the `workspace_id` column — a NULL
 * value, exactly like an older row. `loadWorkspaces` cannot place it in any
 * workspace without the fallback attribution, which is what makes the
 * viewer's account look like a single-workspace account to begin with.
 */
function baseFixture(): Fixture {
  return {
    profiles: [
      { id: VIEWER, email: "viewer@test.local" },
      { id: OWNER_A, email: "ownera@test.local" },
      { id: SOLO, email: "solo@test.local" },
    ],
    portalWorkspaces: [
      { id: WS_VIEWER, name: "Viewer workspace", owner_user_id: VIEWER, is_default: true },
      { id: WS_A, name: "Owner A workspace", owner_user_id: OWNER_A, is_default: true },
      { id: WS_SOLO, name: "Solo workspace", owner_user_id: SOLO, is_default: true },
    ],
    accountLinkInvites: [
      {
        id: "invite-a-to-viewer",
        inviter_user_id: OWNER_A,
        invitee_user_id: VIEWER,
        invitee_display_name: "Viewer",
        assigned_property_ids: ["house-a1"],
        property_co_manager_permissions: { "house-a1": { inbox: { read: true } } },
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
      // Older row: granted to the viewer, but never stamped with a workspace_id.
      { id: "house-a1", manager_user_id: OWNER_A, workspace_id: null, row_data: {}, status: "live" },
      // Owner A's other house was never granted at all.
      { id: "house-a2", manager_user_id: OWNER_A, workspace_id: WS_A, row_data: {}, status: "live" },
      { id: "house-solo", manager_user_id: SOLO, workspace_id: WS_SOLO, row_data: {}, status: "live" },
    ],
  };
}

beforeEach(() => {
  state.cookieValue = undefined;
});

describe("resolveCommunicationScope — a co-manager's own workspace never widens into a grant", () => {
  it("shows none of owner A's threads while the co-manager's OWN single workspace is active", async () => {
    const db = fakeDb(baseFixture());
    const scope = await resolveCommunicationScope(db, VIEWER, "read", { selectedWorkspaceId: WS_VIEWER });

    expect(scope.activeWorkspaceId).toBe(WS_VIEWER);
    expect(scope.workspaceHouseIds).not.toBeNull();
    expect(conversationVisible(scope, { ownerId: OWNER_A, houseIds: ["house-a1"] })).toBe(false);
    expect(conversationVisible(scope, { ownerId: OWNER_A, houseIds: ["house-a2"] })).toBe(false);
  });

  it("shows exactly the granted house's threads, and no other house of owner A's, once owner A's workspace is active", async () => {
    const db = fakeDb(baseFixture());
    const scope = await resolveCommunicationScope(db, VIEWER, "read", { selectedWorkspaceId: WS_A });

    expect(scope.activeWorkspaceId).toBe(WS_A);
    expect(conversationVisible(scope, { ownerId: OWNER_A, houseIds: ["house-a1"] })).toBe(true);
    // house-a2 was never granted, regardless of which workspace is active.
    expect(conversationVisible(scope, { ownerId: OWNER_A, houseIds: ["house-a2"] })).toBe(false);
  });

  it("still shows an ordinary single-workspace owner every one of their own threads (no regression)", async () => {
    const db = fakeDb(baseFixture());
    const scope = await resolveCommunicationScope(db, SOLO, "read", { selectedWorkspaceId: WS_SOLO });

    expect(scope.activeWorkspaceId).toBe(WS_SOLO);
    expect(conversationVisible(scope, { ownerId: SOLO, houseIds: ["house-solo"] })).toBe(true);
  });

  it("keeps a house-less thread the viewer owns under the existing default-workspace rule", async () => {
    const db = fakeDb(baseFixture());
    const scope = await resolveCommunicationScope(db, SOLO, "read", { selectedWorkspaceId: WS_SOLO });

    expect(conversationVisible(scope, { ownerId: SOLO, houseIds: [] })).toBe(true);
  });
});

describe("activeWorkspacePropertyScope — narrows a single workspace instead of skipping it", () => {
  it("returns the single workspace's own property ids rather than null", async () => {
    const db = fakeDb(baseFixture());

    const result = await activeWorkspacePropertyScope(db, SOLO);

    expect(result).not.toBeNull();
    expect(result).toEqual(["house-solo"]);
  });

  it("returns an empty array, not null, for a workspace holding no houses", async () => {
    const fixture = baseFixture();
    fixture.portalWorkspaces.push({ id: "ws-empty", name: "Empty", owner_user_id: "empty-owner", is_default: true });
    fixture.profiles.push({ id: "empty-owner", email: "empty@test.local" });
    const db = fakeDb(fixture);

    const result = await activeWorkspacePropertyScope(db, "empty-owner");

    expect(result).not.toBeNull();
    expect(result).toEqual([]);
  });
});

describe("loadWorkspaces — a granted property with no workspace_id falls back to the owner's default workspace", () => {
  it("attributes the property to the granting owner's default workspace, not a new one", async () => {
    const db = fakeDb(baseFixture());
    const { loadWorkspaces } = await import("@/lib/workspaces/server");

    const workspaces = await loadWorkspaces(db, VIEWER);

    const ownerAWorkspace = workspaces.find((w) => w.id === WS_A);
    expect(ownerAWorkspace).toBeDefined();
    expect(ownerAWorkspace?.propertyIds).toEqual(["house-a1"]);
    // house-a2 belongs to owner A but was never granted, so it stays out of
    // the co-manager's read of that workspace entirely.
    expect(ownerAWorkspace?.propertyIds).not.toContain("house-a2");
  });
});
