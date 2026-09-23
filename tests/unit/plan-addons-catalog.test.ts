import { describe, expect, it } from "vitest";

import {
  includedWorkNumbers,
  maxExtraWorkNumberQuantity,
  maxExtraWorkspaceQuantity,
  maxWorkNumbersForWorkspaces,
} from "@/lib/plan-addons";
import { WORKSPACE_LIMIT, WORKSPACE_PLAN_ENTITLEMENTS } from "@/lib/workspaces/types";

describe("plan entitlements (PLAN-0920)", () => {
  it("includes 2 Business workspaces", () => {
    expect(WORKSPACE_PLAN_ENTITLEMENTS.business.workspaces).toBe(2);
  });

  describe("includedWorkNumbers", () => {
    it("gives Free none", () => {
      expect(includedWorkNumbers("free", 1)).toBe(0);
    });
    it("gives Pro exactly one, regardless of workspace count", () => {
      expect(includedWorkNumbers("pro", 1)).toBe(1);
      expect(includedWorkNumbers("pro", 3)).toBe(1);
    });
    it("gives Business one per workspace", () => {
      expect(includedWorkNumbers("business", 2)).toBe(2);
      expect(includedWorkNumbers("business", 4)).toBe(4);
    });
    it("floors a grandfathered Business account with zero counted workspaces at 1", () => {
      expect(includedWorkNumbers("business", 0)).toBe(1);
    });
  });

  describe("work number caps", () => {
    it("allows 1 per workspace (hard product limit)", () => {
      expect(maxWorkNumbersForWorkspaces(2)).toBe(2);
      expect(maxWorkNumbersForWorkspaces(4)).toBe(4);
    });

    it("sells no extra work numbers — 1 per workspace is the ceiling", () => {
      expect(maxExtraWorkNumberQuantity("business", 2)).toBe(0);
      expect(maxExtraWorkNumberQuantity("pro", 1)).toBe(0);
    });
  });

  describe("maxExtraWorkspaceQuantity", () => {
    it("caps Pro at the database ceiling minus included workspaces", () => {
      expect(maxExtraWorkspaceQuantity("pro", WORKSPACE_PLAN_ENTITLEMENTS.pro.workspaces, WORKSPACE_LIMIT)).toBe(
        WORKSPACE_LIMIT - WORKSPACE_PLAN_ENTITLEMENTS.pro.workspaces,
      );
    });

    it("caps Business at the database ceiling minus included workspaces", () => {
      expect(maxExtraWorkspaceQuantity("business", WORKSPACE_PLAN_ENTITLEMENTS.business.workspaces, WORKSPACE_LIMIT)).toBe(
        WORKSPACE_LIMIT - WORKSPACE_PLAN_ENTITLEMENTS.business.workspaces,
      );
    });
  });
});
