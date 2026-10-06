import { afterEach, describe, expect, it } from "vitest";
import { activeWorkspaceLivePropertyIds, activeWorkspacePropertyIds, setWorkspaceSelection } from "@/lib/workspaces/selection";
import type { WorkspacePayload } from "@/lib/workspaces/types";

function payload(extra: Record<string, unknown>): WorkspacePayload {
  return {
    activeWorkspaceId: "w1",
    workspaces: [{ id: "w1", name: "W", ownerUserId: "u", owned: true, isDefault: true, propertyIds: ["a", "draft", "b"], propertyPermissions: {}, members: [], ...extra }],
  } as unknown as WorkspacePayload;
}

describe("Bookings property ids", () => {
  afterEach(() => setWorkspaceSelection(null));

  it("drops drafts from the Bookings list but not from scoping", () => {
    setWorkspaceSelection(payload({ livePropertyIds: ["a", "b"] }));
    expect(activeWorkspaceLivePropertyIds()).toEqual(["a", "b"]);
    expect(activeWorkspacePropertyIds()).toEqual(["a", "draft", "b"]);
  });

  it("falls back to every id when the payload carries no live list", () => {
    setWorkspaceSelection(payload({}));
    expect(activeWorkspaceLivePropertyIds()).toEqual(["a", "draft", "b"]);
  });

  it("is null before a workspace is selected", () => {
    expect(activeWorkspaceLivePropertyIds()).toBeNull();
  });
});
