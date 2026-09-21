/**
 * Pure logic behind the Settings scope multi-select's workspace/house tree —
 * see `src/lib/scope/settings-scope-tree.ts` for the rules. Exercised
 * directly (no DOM) so the header/house promote-demote edge cases are cheap
 * to assert; `settings-scope-bar.test.tsx` covers the same rules through
 * real clicks.
 */
import { describe, expect, it } from "vitest";
import {
  resolveScopeTreeChange,
  scopeTreeCheckedValues,
  summarizeScopeTreeSelection,
  workspaceOptionValue,
  type ScopeTreeWorkspace,
} from "@/lib/scope/settings-scope-tree";

const WORKSPACES: ScopeTreeWorkspace[] = [
  { id: "ws-1", propertyIds: ["p1", "p2"] },
  { id: "ws-2", propertyIds: ["p3", "p4"] },
];

describe("scopeTreeCheckedValues", () => {
  it("a whole-workspace pick also shows its houses checked", () => {
    const values = scopeTreeCheckedValues(WORKSPACES, { workspaceIds: ["ws-1"], propertyIds: [] });
    expect(values.sort()).toEqual([workspaceOptionValue("ws-1"), "p1", "p2"].sort());
  });

  it("an individually-picked house shows only itself checked", () => {
    const values = scopeTreeCheckedValues(WORKSPACES, { workspaceIds: [], propertyIds: ["p3"] });
    expect(values).toEqual(["p3"]);
  });
});

describe("resolveScopeTreeChange", () => {
  it("checking a workspace header selects the whole workspace, dropping any of its individual picks", () => {
    const next = resolveScopeTreeChange(
      WORKSPACES,
      { workspaceIds: [], propertyIds: ["p1"] },
      [...scopeTreeCheckedValues(WORKSPACES, { workspaceIds: [], propertyIds: ["p1"] }), workspaceOptionValue("ws-1")],
    );
    expect(next).toEqual({ workspaceIds: ["ws-1"], propertyIds: [] });
  });

  it("unchecking a fully-selected workspace's header clears the whole workspace", () => {
    const current = { workspaceIds: ["ws-1"], propertyIds: [] };
    const raw = scopeTreeCheckedValues(WORKSPACES, current).filter((v) => v !== workspaceOptionValue("ws-1"));
    const next = resolveScopeTreeChange(WORKSPACES, current, raw);
    expect(next).toEqual({ workspaceIds: [], propertyIds: [] });
  });

  it("unchecking one house out of a fully-selected workspace demotes the header to its siblings", () => {
    const current = { workspaceIds: ["ws-1"], propertyIds: [] };
    const raw = scopeTreeCheckedValues(WORKSPACES, current).filter((v) => v !== "p1");
    const next = resolveScopeTreeChange(WORKSPACES, current, raw);
    expect(next.workspaceIds).toEqual([]);
    expect(next.propertyIds.sort()).toEqual(["p2"]);
  });

  it("checking every house of a workspace one at a time promotes back to the header", () => {
    const current = { workspaceIds: [], propertyIds: ["p1"] };
    const raw = [...scopeTreeCheckedValues(WORKSPACES, current), "p2"];
    const next = resolveScopeTreeChange(WORKSPACES, current, raw);
    expect(next).toEqual({ workspaceIds: ["ws-1"], propertyIds: [] });
  });

  it("a selection can span several workspaces at once", () => {
    const current = { workspaceIds: ["ws-1"], propertyIds: [] };
    const raw = [...scopeTreeCheckedValues(WORKSPACES, current), "p3"];
    const next = resolveScopeTreeChange(WORKSPACES, current, raw);
    expect(next.workspaceIds).toEqual(["ws-1"]);
    expect(next.propertyIds).toEqual(["p3"]);
  });

  it("checking an already-implied house (its workspace header is selected) is a no-op", () => {
    const current = { workspaceIds: ["ws-1"], propertyIds: [] };
    const raw = scopeTreeCheckedValues(WORKSPACES, current);
    const next = resolveScopeTreeChange(WORKSPACES, current, raw);
    expect(next).toEqual(current);
  });
});

describe("summarizeScopeTreeSelection", () => {
  const named = [
    { id: "ws-1", name: "Ash Flats", propertyIds: ["p1", "p2"] },
    { id: "ws-2", name: "Cedar Row", propertyIds: ["p3"] },
  ];

  it("nothing explicitly selected falls back to the active workspace's name", () => {
    expect(summarizeScopeTreeSelection(named, { workspaceIds: [], propertyIds: [] }, "Ash Flats")).toBe(
      "Ash Flats · all houses",
    );
  });

  it("no active workspace and nothing selected reads All workspaces", () => {
    expect(summarizeScopeTreeSelection(named, { workspaceIds: [], propertyIds: [] }, null)).toBe("All workspaces");
  });

  it("one whole workspace picked reads its name", () => {
    expect(summarizeScopeTreeSelection(named, { workspaceIds: ["ws-2"], propertyIds: [] }, null)).toBe(
      "Cedar Row · all houses",
    );
  });

  it("several whole workspaces picked reads a count", () => {
    expect(summarizeScopeTreeSelection(named, { workspaceIds: ["ws-1", "ws-2"], propertyIds: [] }, null)).toBe(
      "2 workspaces",
    );
  });

  it("one house picked reads '1 house'", () => {
    expect(summarizeScopeTreeSelection(named, { workspaceIds: [], propertyIds: ["p1"] }, null)).toBe("1 house");
  });

  it("houses spanning two workspaces read 'N houses in M workspaces'", () => {
    expect(summarizeScopeTreeSelection(named, { workspaceIds: ["ws-1"], propertyIds: ["p3"] }, null)).toBe(
      "3 houses in 2 workspaces",
    );
  });
});
