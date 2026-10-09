import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Disabling or re-enabling an account needs a reason that reaches the audit trail. The route enforces
 * it; this pins that every Disable / Enable control goes through the reason popup and sends it.
 */
describe("Disable / Enable account asks for a reason", () => {
  it("the shared hook PATCHes active together with the reason", () => {
    const hook = read("src/components/portal/use-admin-account-actions.ts");
    expect(hook).toContain("JSON.stringify({ id, active, reason })");
  });

  it("the Accounts list and the record page open the reason popup instead of toggling directly", () => {
    for (const file of [
      "src/components/portal/admin-axis-users-client.tsx",
      "src/components/portal/admin-account-record-page.tsx",
    ]) {
      const src = read(file);
      expect(src, file).toContain("<AdminAccountActiveDialog");
      expect(src, file).toContain("askActive(");
      expect(src, file).not.toMatch(/void setActive\(/);
    }
  });

  it("the dialog is the existing billing reason popup", () => {
    expect(read("src/components/portal/admin-account-active-dialog.tsx")).toContain("<AdminBillingActionDialog");
  });

  it("the manager Danger zone toggle sends a reason from the same popup", () => {
    const src = read("src/components/portal/admin-manager-account-detail.tsx");
    expect(src).toContain("active: !row.active, reason");
    expect(src).toContain('dataAttr="admin-manager-active-dialog"');
  });
});
