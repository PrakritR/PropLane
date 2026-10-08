import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// S021 (captain, 2026-09-27) dropped the reminders-hub gear from Tours,
// Applications, Leases, Residents, Tasks, Bookings, and Inspections — their
// reminder settings stay reachable from the central Settings hub instead.
// Payments keeps its own gear. Services list gear removed (captain 2026-10-03);
// Communication's gear removed too (captain 2026-10-05) — its preferences are
// reached from the Settings hub's Communication tab.
// Settings gears now go to a Settings page (captain, 2026-10-07): Payments mounts
// the shared ManagerSettingsGear, which is where the lucide Settings glyph lives.
const GEAR_HOST = "src/components/portal/manager-settings-gear.tsx";
const FILES = ["src/components/portal/pro-payments.tsx"];

/** A list page whose toolbar carries no settings gear at all. */
const NO_GEAR_FILES = [
  "src/components/portal/pro-properties.tsx",
  "src/components/portal/pro-communication.tsx",
];

describe("settings command icons are a gear", () => {
  it("portal list chrome uses lucide Settings, not Settings2", () => {
    const host = readFileSync(join(process.cwd(), GEAR_HOST), "utf8");
    expect(host, GEAR_HOST).not.toContain("Settings2");
    expect(host, GEAR_HOST).toContain("icon={Settings}");
    for (const rel of FILES) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel).not.toContain("Settings2");
      expect(src, rel).toContain("<ManagerSettingsGear");
    }
    for (const rel of NO_GEAR_FILES) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel).not.toContain("icon={Settings}");
      expect(src, rel).not.toContain("Settings2");
    }
  });
});
