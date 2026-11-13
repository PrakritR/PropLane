import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const routes = ["task-automation-settings", "reminder-settings", "automation-settings", "automated-messages", "lease-automation-settings", "manager-listing-late-fee-settings", "manager-manual-payment-settings", "manager-tour-settings", "tour-reminders", "service-automation-settings", "google-calendar", "google-calendar/connect", "google-calendar/events", "google-calendar/link-session", "google-calendar/pending-changes", "google-calendar/pending-changes/[id]", "channel-calendar/bookings", "channel-calendar/connections", "channel-calendar/health", "channel-calendar/sync"];
describe("manager settings authorization surface", () => {
  it.each(routes)("%s checks a stored manager role and does not trust metadata", (route) => {
    const source = readFileSync(`src/app/api/portal/${route}/route.ts`, "utf8");
    // The stored-role check is `userHoldsManagerRole` itself or its strict twin behind `resolveManagerRouteActor` (503 on a failed read).
    expect(/userHoldsManagerRole\(db, user\.id\)|resolveManagerRouteActor\(/.test(source)).toBe(true);
    expect(source).not.toMatch(/user_metadata\?\.role/);
  });
  it("keeps promotion oversight behind a stored admin role", () => {
    const source = readFileSync("src/app/api/portal-promotions/route.ts", "utf8");
    expect(source).toContain('eq("role", "admin")');
    expect(source).toContain("resolveAdminOversight(req, user.id, admin)");
    expect(source).not.toMatch(/user_metadata\?\.role/);
  });
});
