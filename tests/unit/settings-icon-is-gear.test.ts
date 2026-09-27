import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// S021 (captain, 2026-09-27) dropped the reminders-hub gear from Tours,
// Applications, Leases, Residents, Tasks, Bookings, and Inspections — their
// reminder settings stay reachable from the central Settings hub instead.
// Payments and Communication keep their own gear, and Services keeps its
// gear because it is also the only way to the per-property service catalog.
const FILES = [
  "src/components/portal/pro-payments.tsx",
  "src/components/portal/pro-communication.tsx",
  "src/components/portal/pro-all-services-panel.tsx",
];

describe("settings command icons are a gear", () => {
  it("portal list chrome uses lucide Settings, not Settings2", () => {
    for (const rel of FILES) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel).not.toContain("Settings2");
      expect(src, rel).toContain("icon={Settings}");
    }
    const properties = readFileSync(join(process.cwd(), "src/components/portal/pro-properties.tsx"), "utf8");
    expect(properties).not.toContain("icon={Settings}");
    expect(properties).not.toContain("Settings2");
  });
});
