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
    it("allows 2 per workspace", () => {
      expect(maxWorkNumbersForWorkspaces(2)).toBe(4);
      expect(maxWorkNumbersForWorkspaces(4)).toBe(8);
    });

    it("derives the extra_work_number ceiling from included numbers", () => {
      // Business, 2 workspaces: included 2, ceiling 4 → 2 purchasable extra.
      expect(maxExtraWorkNumberQuantity("business", 2)).toBe(2);
      // Pro, 1 workspace: included 1, ceiling 2 → 1 purchasable extra.
      expect(maxExtraWorkNumberQuantity("pro", 1)).toBe(1);
    });
  });

  describe("maxExtraWorkspaceQuantity", () => {
    it("caps Pro at the product limit (2 extra, 3 total)", () => {
      expect(maxExtraWorkspaceQuantity("pro", WORKSPACE_PLAN_ENTITLEMENTS.pro.workspaces, WORKSPACE_LIMIT)).toBe(2);
    });

    it("caps Business at the database ceiling minus included workspaces", () => {
      expect(maxExtraWorkspaceQuantity("business", WORKSPACE_PLAN_ENTITLEMENTS.business.workspaces, WORKSPACE_LIMIT)).toBe(
        WORKSPACE_LIMIT - WORKSPACE_PLAN_ENTITLEMENTS.business.workspaces,
      );
    });
  });
});
