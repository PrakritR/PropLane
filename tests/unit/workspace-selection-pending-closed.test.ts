import { afterEach, describe, expect, it } from "vitest";
import {
  activeWorkspaceNonDraftPropertyIds,
  activeWorkspacePropertyIds,
  isActiveWorkspaceId,
  rowInActiveWorkspace,
  setWorkspaceSelection,
  workspaceContainsProperty,
} from "@/lib/workspaces/selection";
import type { WorkspacePayload } from "@/lib/workspaces/types";

/** Issue #103 (mechanism A): until /api/workspaces answers, the client filters show nothing, never the whole account. */

const payload = (workspaces: { id: string; propertyIds: string[] }[], activeWorkspaceId: string | null) =>
  ({
    activeWorkspaceId,
    workspaces: workspaces.map((w) => ({ ...w, name: w.id, ownerUserId: "o", owned: true, isDefault: false })),
  }) as unknown as WorkspacePayload;

afterEach(() => setWorkspaceSelection(null));

describe("client workspace filters before the selection loads", () => {
  it("are closed while the selection is pending", () => {
    setWorkspaceSelection(null);
    expect(workspaceContainsProperty("house-a")).toBe(false);
    expect(workspaceContainsProperty(null)).toBe(false);
    expect(isActiveWorkspaceId("ws-a")).toBe(false);
    expect(rowInActiveWorkspace(["house-a"])).toBe(false);
    expect(rowInActiveWorkspace([])).toBe(false);
    expect(activeWorkspacePropertyIds()).toEqual([]);
    expect(activeWorkspaceNonDraftPropertyIds()).toEqual([]);
  });

  it("narrow to the active workspace once it loads", () => {
    setWorkspaceSelection(payload([{ id: "ws-a", propertyIds: ["house-a"] }, { id: "ws-b", propertyIds: ["house-b"] }], "ws-b"));
    expect(workspaceContainsProperty("house-b")).toBe(true);
    expect(workspaceContainsProperty("house-a")).toBe(false);
    expect(activeWorkspacePropertyIds()).toEqual(["house-b"]);
  });

  it("pass everything for an account with no workspace at all (nothing to narrow by)", () => {
    setWorkspaceSelection(payload([], null));
    expect(workspaceContainsProperty("house-a")).toBe(true);
    expect(rowInActiveWorkspace([])).toBe(true);
    expect(activeWorkspacePropertyIds()).toBeNull();
  });
});
