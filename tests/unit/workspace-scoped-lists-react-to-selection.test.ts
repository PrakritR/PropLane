import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * C201: Properties and Tours filter their rows through `workspaceContainsProperty`,
 * which reads the active workspace off a plain module variable (`selection.ts`),
 * not React state. A memo that calls it but never depends on the reactive
 * `useSelectedWorkspaceId()` id can compute against a workspace still mid-load
 * and then never recompute once the real one lands — the list reads empty
 * until an unrelated state change (or a full reload) happens to re-run it.
 *
 * This is a source guard, not a render test: it asserts the wiring stays in
 * place rather than re-proving the hook itself (already covered by
 * `use-selected-workspace-id`'s own consumers).
 */
const propertiesSrc = readFileSync("src/components/portal/pro-properties.tsx", "utf8");
const toursSrc = readFileSync("src/components/portal/pro-tours.tsx", "utf8");

describe("workspace-scoped list memos react to the active workspace resolving", () => {
  it("Properties reads the reactive workspace id and depends on it", () => {
    expect(propertiesSrc).toContain('useSelectedWorkspaceId } from "@/hooks/use-selected-workspace-id"');
    expect(propertiesSrc).toContain("const activeWorkspaceId = useSelectedWorkspaceId();");
    // stageCounts (tab counts) and shareableProperties (share-link picker) both
    // filter through workspaceContainsProperty — both must recompute on switch.
    expect(propertiesSrc).toMatch(/\[portfolioTick, scopeUserId, activeWorkspaceId\]/);
    expect(propertiesSrc).toMatch(/\[scopeUserId, portfolioTick, activeWorkspaceId\]/);
  });

  it("Tours reads the reactive workspace id and depends on it in allRows", () => {
    expect(toursSrc).toContain('useSelectedWorkspaceId } from "@/hooks/use-selected-workspace-id"');
    expect(toursSrc).toContain("const activeWorkspaceId = useSelectedWorkspaceId();");
    expect(toursSrc).toMatch(/\[tick, userId, scopedPropertyId, activeWorkspaceId\]/);
  });
});
