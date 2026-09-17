import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve("src/components/portal/portal-profile-client.tsx"), "utf8");

function groupFor(id: string): string | null {
  const block = src.split(`id: "${id}"`)[1];
  if (!block) return null;
  const match = block.match(/group:\s*"(Account|Operations|Portfolio)"/);
  return match?.[1] ?? null;
}

describe("settings account vs operations groups", () => {
  it("keeps person settings on Account", () => {
    expect(groupFor("profile")).toBe("Account");
    expect(groupFor("preferences")).toBe("Account");
    expect(groupFor("notifications")).toBe("Account");
    expect(groupFor("security")).toBe("Account");
    expect(groupFor("feedback")).toBe("Account");
    expect(groupFor("account")).toBe("Account");
  });

  it("puts Workspaces on Account — the roster belongs to the login", () => {
    expect(groupFor("workspaces")).toBe("Account");
  });

  it("puts Communication on Operations — it follows the top-left workspace", () => {
    expect(groupFor("team")).toBeNull();
    expect(groupFor("vendors")).toBeNull();
    expect(groupFor("messaging")).toBe("Operations");
  });

  it("puts Application, Lease, and Tour modules on Portfolio — Properties is not a settings pane", () => {
    expect(groupFor("properties")).toBeNull();
    expect(groupFor("applications")).toBe("Portfolio");
    expect(groupFor("lease")).toBe("Portfolio");
    expect(groupFor("tours")).toBe("Portfolio");
    expect(groupFor("resident")).toBe("Portfolio");
  });

  it("puts remaining workspace modules on Operations", () => {
    expect(groupFor("payments")).toBe("Operations");
    expect(groupFor("tasks")).toBe("Operations");
    expect(groupFor("reminders")).toBe("Operations");
    expect(groupFor("bookings")).toBe("Operations");
    expect(groupFor("inspections")).toBe("Operations");
    expect(groupFor("services")).toBe("Operations");
  });

  it("moves Billing and API onto Account — they belong to the login", () => {
    expect(groupFor("billing")).toBe("Account");
    expect(groupFor("developer")).toBe("Account");
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

  it("aliases ?tab=properties onto Applications", () => {
    expect(src).toContain('rawTab === "properties"');
    expect(src).toContain('router.replace("/portal/profile?tab=applications")');
  });

  it("aliases ?tab=residents onto the Residents hub pane", () => {
    expect(src).toContain('rawTab === "residents"');
    expect(src).toContain('router.replace("/portal/profile?tab=resident")');
  });

  it("puts Manager alerts on Notifications, not Preferences", () => {
    expect(src).toContain('id: "notifications"');
    const prefs = src.slice(src.indexOf('case "preferences"'), src.indexOf('case "notifications"'));
    expect(prefs).not.toContain("ManagerNotificationRoutingSetting");
    expect(src.slice(src.indexOf('case "notifications"'))).toContain("ManagerNotificationRoutingSetting");
  });
});
