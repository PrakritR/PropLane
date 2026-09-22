import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/workspaces/row-scope.server.ts` is the ONE resolver the manager
 * money / document library surfaces (bills, budgets, owner distributions,
 * expenses, documents) share for active-workspace narrowing. These tests
 * cover its two building blocks directly: the DB+cookie resolution (matching
 * `activeWorkspacePropertyScope`'s null/empty contract, plus the extra
 * "is this the viewer's own default" signal account-level rows need) and the
 * pure decision/query-building functions built on top of it. Per-surface
 * proof (two workspaces, an empty workspace, a single-workspace account
 * unaffected, account-level default-workspace rule) lives in each surface's
 * own test file; this file is the shared foundation those all rely on.
 */

const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined, cookiesThrow: false }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => {
    if (state.cookiesThrow) throw new Error("no request scope");
    return { get: (_name: string) => (state.cookieValue !== undefined ? { value: state.cookieValue } : undefined) };
  }),
}));

const mocks = vi.hoisted(() => ({ loadWorkspaces: vi.fn() }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: mocks.loadWorkspaces }));

import {
  applyWorkspaceRowScope,
  resolveActiveWorkspaceRowScope,
  rowAllowedInWorkspaceScope,
} from "@/lib/workspaces/row-scope.server";
import { fakeSupabaseClient } from "./helpers/fake-supabase-tables";

const OWNED_DEFAULT = { id: "ws-default", name: "Default", ownerUserId: "mgr-1", owned: true, isDefault: true, propertyIds: ["p1", "p2"] };
const OWNED_SECOND = { id: "ws-second", name: "Second", ownerUserId: "mgr-1", owned: true, isDefault: false, propertyIds: ["p3"] };
const OWNED_EMPTY = { id: "ws-empty", name: "Empty", ownerUserId: "mgr-1", owned: true, isDefault: false, propertyIds: [] };
const SHARED_NOT_DEFAULT = { id: "ws-shared", name: "Shared", ownerUserId: "owner-2", owned: false, isDefault: false, propertyIds: ["p9"] };

beforeEach(() => {
  state.cookieValue = undefined;
  state.cookiesThrow = false;
  mocks.loadWorkspaces.mockReset();
});

describe("resolveActiveWorkspaceRowScope", () => {
  it("does not narrow when the account has no workspace at all", async () => {
    mocks.loadWorkspaces.mockResolvedValue([]);
    const scope = await resolveActiveWorkspaceRowScope({} as never, "mgr-1");
    expect(scope).toEqual({ propertyIds: null, includeUntagged: true });
  });

  it("does not narrow when the workspace load fails (never widen on a resolution failure)", async () => {
    mocks.loadWorkspaces.mockRejectedValue(new Error("db down"));
    const scope = await resolveActiveWorkspaceRowScope({} as never, "mgr-1");
    expect(scope).toEqual({ propertyIds: null, includeUntagged: true });
  });

  it("a single owned-default workspace narrows to its own houses and is untagged-visible", async () => {
    mocks.loadWorkspaces.mockResolvedValue([OWNED_DEFAULT]);
    const scope = await resolveActiveWorkspaceRowScope({} as never, "mgr-1");
    expect(scope).toEqual({ propertyIds: ["p1", "p2"], includeUntagged: true });
  });

  it("switches to workspace A when the cookie names it, among several workspaces", async () => {
    mocks.loadWorkspaces.mockResolvedValue([OWNED_DEFAULT, OWNED_SECOND]);
    state.cookieValue = OWNED_DEFAULT.id;
    const scope = await resolveActiveWorkspaceRowScope({} as never, "mgr-1");
    expect(scope.propertyIds).toEqual(["p1", "p2"]);
    expect(scope.includeUntagged).toBe(true);
  });

  it("switches to workspace B when the cookie names it — a non-default workspace excludes account-level rows", async () => {
    mocks.loadWorkspaces.mockResolvedValue([OWNED_DEFAULT, OWNED_SECOND]);
    state.cookieValue = OWNED_SECOND.id;
    const scope = await resolveActiveWorkspaceRowScope({} as never, "mgr-1");
    expect(scope.propertyIds).toEqual(["p3"]);
    expect(scope.includeUntagged).toBe(false);
  });

  it("an active workspace with zero houses narrows to an empty array, not null", async () => {
    mocks.loadWorkspaces.mockResolvedValue([OWNED_DEFAULT, OWNED_EMPTY]);
    state.cookieValue = OWNED_EMPTY.id;
    const scope = await resolveActiveWorkspaceRowScope({} as never, "mgr-1");
    expect(scope.propertyIds).toEqual([]);
  });

  it("a shared (not-owned, not-default) active workspace never shows account-level rows", async () => {
    mocks.loadWorkspaces.mockResolvedValue([OWNED_DEFAULT, SHARED_NOT_DEFAULT]);
    state.cookieValue = SHARED_NOT_DEFAULT.id;
    const scope = await resolveActiveWorkspaceRowScope({} as never, "mgr-1");
    expect(scope).toEqual({ propertyIds: ["p9"], includeUntagged: false });
  });

  it("falls back to the first workspace when no cookie is set", async () => {
    mocks.loadWorkspaces.mockResolvedValue([OWNED_DEFAULT, OWNED_SECOND]);
    const scope = await resolveActiveWorkspaceRowScope({} as never, "mgr-1");
    expect(scope.propertyIds).toEqual(["p1", "p2"]);
  });

  it("degrades safely (never throws, never narrows) when cookies() is unavailable outside a request", async () => {
    mocks.loadWorkspaces.mockResolvedValue([OWNED_DEFAULT, OWNED_SECOND]);
    state.cookiesThrow = true;
    const scope = await resolveActiveWorkspaceRowScope({} as never, "mgr-1");
    expect(scope.propertyIds).toEqual(["p1", "p2"]); // falls back to workspaces[0]
  });
});

describe("rowAllowedInWorkspaceScope", () => {
  it("allows everything when not narrowing", () => {
    expect(rowAllowedInWorkspaceScope({ propertyIds: null, includeUntagged: false }, "any-property")).toBe(true);
    expect(rowAllowedInWorkspaceScope({ propertyIds: null, includeUntagged: false }, null)).toBe(true);
  });

  it("allows a property inside the scope, refuses one outside it", () => {
    const scope = { propertyIds: ["p1", "p2"], includeUntagged: false };
    expect(rowAllowedInWorkspaceScope(scope, "p1")).toBe(true);
    expect(rowAllowedInWorkspaceScope(scope, "p3")).toBe(false);
  });

  it("an account-level row (no property) follows includeUntagged", () => {
    expect(rowAllowedInWorkspaceScope({ propertyIds: ["p1"], includeUntagged: true }, null)).toBe(true);
    expect(rowAllowedInWorkspaceScope({ propertyIds: ["p1"], includeUntagged: false }, null)).toBe(false);
    expect(rowAllowedInWorkspaceScope({ propertyIds: [], includeUntagged: true }, undefined)).toBe(true);
    expect(rowAllowedInWorkspaceScope({ propertyIds: [], includeUntagged: false }, "")).toBe(false);
  });
});

describe("applyWorkspaceRowScope", () => {
  function rows() {
    return [
      { id: "r1", property_id: "p1" },
      { id: "r2", property_id: "p3" },
      { id: "r3", property_id: null },
    ];
  }

  it("does not narrow when scope.propertyIds is null", async () => {
    const db = fakeSupabaseClient({ t: rows() });
    const q = applyWorkspaceRowScope(db.from("t").select(), { propertyIds: null, includeUntagged: false });
    const { data } = await q;
    expect(data?.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("narrows to the scope's properties, excluding account-level rows, when includeUntagged is false", async () => {
    const db = fakeSupabaseClient({ t: rows() });
    const q = applyWorkspaceRowScope(db.from("t").select(), { propertyIds: ["p1"], includeUntagged: false });
    const { data } = await q;
    expect(data?.map((r) => r.id)).toEqual(["r1"]);
  });

  it("narrows to the scope's properties PLUS account-level rows when includeUntagged is true", async () => {
    const db = fakeSupabaseClient({ t: rows() });
    const q = applyWorkspaceRowScope(db.from("t").select(), { propertyIds: ["p1"], includeUntagged: true });
    const { data } = await q;
    expect(data?.map((r) => r.id).sort()).toEqual(["r1", "r3"]);
  });

  it("an empty workspace (propertyIds: []) yields only account-level rows when untagged, else none", async () => {
    const db1 = fakeSupabaseClient({ t: rows() });
    const untagged = await applyWorkspaceRowScope(db1.from("t").select(), { propertyIds: [], includeUntagged: true });
    expect(untagged.data?.map((r) => r.id)).toEqual(["r3"]);

    const db2 = fakeSupabaseClient({ t: rows() });
    const none = await applyWorkspaceRowScope(db2.from("t").select(), { propertyIds: [], includeUntagged: false });
    expect(none.data ?? []).toEqual([]);
  });
});
