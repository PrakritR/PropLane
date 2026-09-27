import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Vendor Invoices' status filter (Pending / Paid, `vendor-payments-panel.tsx`,
 * rendered at /vendor/financials/invoices) used a rounded pill segmented
 * control (`ManagerPortalStatusPills`) while every other status filter in the
 * product — manager Payments, Leases, Tours, Applications; resident Payments —
 * uses the plain underline tabs (`LocalDestinationNav`/`DestinationNav`
 * `appearance="command"`). N066 matches it to that shape. See AGENTS.md
 * "Portal UI system" and `docs/agents/vendor-portal.md`.
 */
describe("vendor Invoices status filter uses underline tabs, not pills", () => {
  it("vendor-payments-panel.tsx never imports or renders ManagerPortalStatusPills", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/vendor-payments-panel.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/ManagerPortalStatusPills/);
  });

  it("vendor-payments-panel.tsx renders its status filter as command-appearance underline tabs", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/vendor-payments-panel.tsx"),
      "utf8",
    );
    expect(source).toMatch(/LocalDestinationNav/);
    expect(source).toMatch(/appearance="command"/);
  });
});
