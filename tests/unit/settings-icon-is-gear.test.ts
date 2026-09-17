import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FILES = [
  "src/components/portal/pro-leases.tsx",
  "src/components/portal/pro-applications.tsx",
  "src/components/portal/pro-bookings.tsx",
  "src/components/portal/pro-properties.tsx",
  "src/components/portal/pro-task-list.tsx",
];

describe("settings command icons are a gear", () => {
  it("portal list chrome uses lucide Settings, not Settings2", () => {
    for (const rel of FILES) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel).not.toContain("Settings2");
      expect(src, rel).toContain("icon={Settings}");
    }
  });
});
