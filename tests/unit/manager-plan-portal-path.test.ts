import { describe, expect, it } from "vitest";
import { MANAGER_PLAN_PORTAL_URL, MANAGER_PLAN_BILLING_RETURN_PATH } from "@/lib/portals/manager-plan-path";

describe("manager plan portal path", () => {
  it("opens billing via tab query so View plans works from Workspaces", () => {
    expect(MANAGER_PLAN_PORTAL_URL).toContain("tab=billing");
    expect(MANAGER_PLAN_PORTAL_URL).toContain("#portal-plan");
    expect(MANAGER_PLAN_BILLING_RETURN_PATH).toBe("/portal/profile?tab=billing");
  });
});
