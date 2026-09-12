/**
 * An empty workspace must read as "nothing here" while the account still holds
 * homes elsewhere — the counts and the empty state agree with the list filter.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  activeWorkspaceScope,
  propertiesOutsideActiveWorkspace,
  setWorkspaceSelection,
  workspaceContainsProperty,
} from "@/lib/workspaces/selection";

const payload = {
  activeWorkspaceId: "w-33",
  workspaces: [
    { id: "w-default", name: "My workspace", ownerUserId: "u", owned: true, isDefault: true, propertyIds: ["p1", "p2"], propertyPermissions: {} },
    { id: "w-33", name: "33", ownerUserId: "u", owned: true, isDefault: false, propertyIds: [], propertyPermissions: {} },
  ],
};

afterEach(() => setWorkspaceSelection(null));

describe("active workspace scope", () => {
  it("names the empty workspace and counts the homes it is missing", () => {
    setWorkspaceSelection(payload);
    expect(activeWorkspaceScope()).toEqual({ name: "33", isDefault: false, propertyCount: 0 });
    expect(propertiesOutsideActiveWorkspace()).toBe(2);
    expect(workspaceContainsProperty("p1")).toBe(false);
  });

  it("reads the whole account before a selection exists", () => {
    expect(activeWorkspaceScope()).toBeNull();
    expect(propertiesOutsideActiveWorkspace()).toBe(0);
    expect(workspaceContainsProperty("p1")).toBe(true);
  });

  it("is quiet in the default workspace that holds the homes", () => {
    setWorkspaceSelection({ ...payload, activeWorkspaceId: "w-default" });
    expect(activeWorkspaceScope()).toMatchObject({ name: "My workspace", propertyCount: 2 });
    expect(propertiesOutsideActiveWorkspace()).toBe(0);
  });
});
