import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(process.cwd(), "src/components/portal/manager-portal-settings-modal.tsx"),
  "utf8",
);

describe("ManagerPortalSettingsModal mount gating", () => {
  it("mounts self-loading panels only while the modal is open", () => {
    expect(SRC).toMatch(/\{open && tab === "calendar" \?/);
    expect(SRC).toMatch(/\{open && tab === "payments" \?/);
    expect(SRC).toMatch(/\{open && tab === "communication" \?/);
    expect(SRC).toMatch(/\{open && tab === "automation" \?/);
    expect(SRC).toMatch(/\{open && tab === "tasks" \?/);
  });
});
