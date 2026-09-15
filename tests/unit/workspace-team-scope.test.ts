import { describe, expect, it } from "vitest";
import { assignedIdsInWorkspace, teamGrantVisibleInWorkspace } from "@/lib/workspaces/team-scope";

describe("teamGrantVisibleInWorkspace", () => {
  const workspace = ["house-a", "house-b"];

  it("shows an invite that has no houses yet so it can be assigned here", () => {
    expect(teamGrantVisibleInWorkspace([], workspace)).toBe(true);
    expect(teamGrantVisibleInWorkspace([], [])).toBe(true);
  });

  it("shows a member who has a house in this workspace", () => {
    expect(teamGrantVisibleInWorkspace(["house-b", "other"], workspace)).toBe(true);
  });

  it("hides a member whose houses are only in another workspace", () => {
    expect(teamGrantVisibleInWorkspace(["other"], workspace)).toBe(false);
    expect(teamGrantVisibleInWorkspace(["other"], [])).toBe(false);
  });

  it("returns only the houses that sit in this workspace", () => {
    expect(assignedIdsInWorkspace(["house-a", "other", "house-b"], workspace)).toEqual(["house-a", "house-b"]);
  });
});
