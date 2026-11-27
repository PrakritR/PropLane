import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Issue #103 (mechanism B). When `loadWorkspaces` throws, every narrowing helper used to return "do not narrow",
 * which for an account that reaches several workspaces (a staff seat on two managed workspaces, a co-manager grant)
 * meant the UNION of every workspace it can reach while one specific workspace was open. They now fail closed.
 */

const state = vi.hoisted(() => ({ workspacesFail: true, cookie: "ws-b" as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => (state.cookie ? { value: state.cookie } : undefined) })),
}));
vi.mock("@/lib/workspaces/server", () => ({
  loadWorkspaces: vi.fn(async () => {
    if (state.workspacesFail) throw new Error("Could not load workspace access. Please retry.");
    return [
      { id: "ws-a", propertyIds: ["house-a"], owned: false, isDefault: false },
      { id: "ws-b", propertyIds: ["house-b"], owned: false, isDefault: false },
    ];
  }),
}));

import { activeWorkspacePropertyScope, assertPropertyInActiveWorkspace } from "@/lib/workspaces/scope.server";
import { resolveManagerWorkspaceRowScope } from "@/lib/auth/co-manager-module-scope";
import { resolveActiveWorkspaceRowScope } from "@/lib/workspaces/row-scope.server";
import { conversationVisible, resolveCommunicationScope } from "@/lib/communication/conversation-visibility.server";
import { WorkspaceScopeUnavailableError } from "@/lib/workspaces/scope-unavailable";

// A db that cannot answer anything: grants and team reads fail, which the resolvers already treat as "share nothing".
const brokenDb = {
  from: () => {
    throw new Error("db down");
  },
} as unknown as SupabaseClient;

beforeEach(() => {
  state.workspacesFail = true;
  state.cookie = "ws-b";
});

describe("a failed workspace load never reads as 'do not narrow'", () => {
  it("activeWorkspacePropertyScope throws instead of returning null", async () => {
    await expect(activeWorkspacePropertyScope(brokenDb, "staff-1")).rejects.toBeInstanceOf(WorkspaceScopeUnavailableError);
  });

  it("assertPropertyInActiveWorkspace refuses instead of passing", async () => {
    await expect(assertPropertyInActiveWorkspace(brokenDb, "staff-1", "house-a")).rejects.toBeInstanceOf(
      WorkspaceScopeUnavailableError,
    );
  });

  it("resolveManagerWorkspaceRowScope throws instead of { propertyIds: null }", async () => {
    await expect(resolveManagerWorkspaceRowScope(brokenDb as never, "staff-1")).rejects.toBeInstanceOf(
      WorkspaceScopeUnavailableError,
    );
  });

  it("resolveActiveWorkspaceRowScope throws instead of { propertyIds: null }", async () => {
    await expect(resolveActiveWorkspaceRowScope(brokenDb, "staff-1")).rejects.toBeInstanceOf(WorkspaceScopeUnavailableError);
  });

  it("resolveCommunicationScope closes: nothing is visible, not the whole account", async () => {
    const scope = await resolveCommunicationScope(brokenDb, "staff-1", "read");
    expect(scope.closed).toBe(true);
    expect(scope.workspaceHouseIds).not.toBeNull();
    // A thread stamped to workspace A while B is open, and a house-a thread.
    expect(conversationVisible(scope, { ownerId: "owner-a", houseIds: ["house-a"], workspaceId: "ws-a" })).toBe(false);
    expect(conversationVisible(scope, { ownerId: "owner-a", houseIds: ["house-a"] })).toBe(false);
    // The Assistant thread of the other workspace's owner.
    expect(
      conversationVisible(scope, { ownerId: "owner-a", houseIds: [], threadType: "agent_notice", threadId: "assistant-thread:owner-a" }),
    ).toBe(false);
    // The viewer's own untagged thread is not shown either (default-workspace rule is off).
    expect(conversationVisible(scope, { ownerId: "staff-1", houseIds: [] })).toBe(false);
  });

  it("still narrows to the active workspace when the load succeeds", async () => {
    state.workspacesFail = false;
    expect(await activeWorkspacePropertyScope(brokenDb, "staff-1")).toEqual(["house-b"]);
    const rows = await resolveManagerWorkspaceRowScope(brokenDb as never, "staff-1");
    expect(rows.propertyIds).toEqual(["house-b"]);
    expect(rows.untaggedOwnedVisible).toBe(false);
  });
});
