import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve("src/components/portal/portal-profile-client.tsx"), "utf8");

function groupFor(id: string): string | null {
  const block = src.split(`id: "${id}"`)[1];
  if (!block) return null;
  const match = block.match(/group:\s*"(Profile|Workspace)"/);
  return match?.[1] ?? null;
}

describe("settings account vs workspace groups (S019/S014, captain 2026-09-27 simplification, corrected 06:47)", () => {
  it("keeps person settings in the Profile group", () => {
    expect(groupFor("profile")).toBe("Profile");
    expect(groupFor("preferences")).toBe("Profile");
    expect(groupFor("security")).toBe("Profile");
    expect(groupFor("feedback")).toBe("Profile");
    expect(groupFor("account")).toBe("Profile");
  });

  it("puts Workspace under the active workspace", () => {
    expect(groupFor("workspaces")).toBe("Workspace");
  });

  it("puts Communication on Workspace — it follows the top-left workspace", () => {
    expect(groupFor("team")).toBeNull();
    expect(groupFor("vendors")).toBeNull();
    expect(groupFor("messaging")).toBe("Workspace");
  });

  it("removed Applications, Leases, Tours, and Residents from Settings — their choices moved to each property's own section", () => {
    expect(groupFor("properties")).toBeNull();
    expect(src).not.toContain('id: "applications"');
    expect(src).not.toContain('id: "lease"');
    expect(src).not.toContain('id: "forms"');
    expect(src).not.toContain('id: "tours"');
    expect(src).not.toContain('id: "resident"');
  });

  it("removes property form and lease sections from workspace navigation", () => {
    expect(groupFor("applicationForm")).toBeNull();
    expect(groupFor("leaseDocuments")).toBeNull();
  });

  it("removed Services and Tasks from Settings, and Reminders and Notifications entirely", () => {
    expect(src).not.toContain('id: "services"');
    expect(src).not.toContain('id: "tasks"');
    expect(src).not.toContain('id: "reminders"');
    expect(src).not.toContain('id: "notifications"');
  });

  it("keeps Balance & payouts on Workspace, and renames Spreadsheets to Integrations", () => {
    expect(groupFor("payments")).toBe("Workspace");
    expect(src).toContain('label: "Balance & payouts"');
    expect(src).not.toContain('label: "Payments"');
    expect(groupFor("payouts")).toBeNull();
    expect(src).toContain('router.replace("/portal/profile?tab=payments")');
    expect(groupFor("spreadsheets")).toBe("Workspace");
    expect(src).toContain('label: "Integrations"');
  });

  it("keeps Billing & plan and API & MCP in the Profile group (captain, 2026-10-03)", () => {
    expect(groupFor("billing")).toBe("Profile");
    expect(groupFor("developer")).toBe("Profile");
  });

  it("redirects the retired Settings Vendors tab to the operations list", () => {
    expect(src).toContain('rawTab === "vendors"');
    expect(src).toContain('router.replace("/portal/vendors")');
    expect(src).not.toContain('id: "vendors"');
  });

  it("redirects the retired Settings Team tab into Workspaces", () => {
    expect(src).toContain('rawTab === "team"');
    expect(src).toContain('router.replace("/portal/profile?tab=workspaces")');
    expect(src).not.toContain('id: "team"');
  });

  it("routes every removed pane's old deep link (and legacy alias) to Profile", () => {
    expect(src).toContain("REMOVED_SETTINGS_TAB_IDS");
    for (const id of [
      "notifications",
      "applications",
      "lease",
      "forms",
      "tours",
      "resident",
      "services",
      "tasks",
      "reminders",
      "properties",
      "automation",
      "leases",
      "residents",
      "bookings",
      "inspections",
    ]) {
      expect(src).toContain(`"${id}"`);
    }
    expect(src).toContain('router.replace("/portal/profile?tab=profile")');
  });

  it("redirects retired property forms away from workspace settings", () => {
    const removedSetBlock = src.slice(src.indexOf("const REMOVED_SETTINGS_TAB_IDS"), src.indexOf("]);") + 3);
    expect(removedSetBlock).toContain('"applicationForm"');
    expect(removedSetBlock).toContain('"leaseDocuments"');
  });
});
