import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C022: admin Communication's embedded Unopened/Opened/Sent status picker
 * (shown above admin's own record table, `tabId === "all"` branch of
 * `admin-inbox-client.tsx`) rendered as a rounded, filled ManagerPortalStatusPills
 * strip instead of the plain underline tabs the rest of Communication's shape
 * uses (see AGENTS.md "Portal UI system"). Swapped to LocalDestinationNav
 * appearance="command". The two-pane list+thread shape and the "Communication"
 * page title were already correct (see the code comment above the
 * InboxTwoPane render); this closes the one remaining pill-shaped control.
 * The legacy standalone (/demo-only) fallback shell keeps its own pill tabs
 * unchanged, matching the documented dead-code convention.
 */
describe("admin Communication's embedded status picker uses underline tabs, not pills", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/portal/admin-inbox-client.tsx"),
    "utf8",
  );

  it("the embedded Unopened/Opened/Sent picker renders LocalDestinationNav appearance=command", () => {
    const embeddedBlockStart = source.indexOf('embeddedInCommunication && tabId === "all"');
    const embeddedBlockEnd = source.indexOf("<div className=\"space-y-5\">");
    expect(embeddedBlockStart).toBeGreaterThan(-1);
    expect(embeddedBlockEnd).toBeGreaterThan(embeddedBlockStart);
    const block = source.slice(embeddedBlockStart, embeddedBlockEnd);
    expect(block).toMatch(/LocalDestinationNav/);
    expect(block).toMatch(/appearance="command"/);
    expect(block).not.toMatch(/ManagerPortalStatusPills/);
  });

  it("the real portal's two-pane shape (InboxTwoPane) still backs the embedded thread view", () => {
    expect(source).toMatch(/InboxTwoPane/);
    expect(source).toMatch(/InboxThreadView/);
  });
});
