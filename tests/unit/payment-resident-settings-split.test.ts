import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL = join(process.cwd(), "src/components/portal");

function src(file: string) {
  return readFileSync(join(PORTAL, file), "utf8");
}

describe("Payment settings owns setup; Residents drop rent reminders", () => {
  it("Payment settings chrome is Payment setup, Rent reminders, Late fees", () => {
    const panels = src("pro-portal-settings-panels.tsx");
    expect(panels).toContain('value: "setup", label: "Payment setup"');
    expect(panels).toContain('value: "rent", label: "Rent reminders"');
    expect(panels).toContain('value: "late-fees", label: "Late fees"');
    expect(panels).toContain("ManagerPaymentSetupPanel");
    expect(panels).toContain('dataAttr="payments-settings-area"');
  });

  it("Resident settings only lists Household reminders", () => {
    const panels = src("pro-portal-settings-panels.tsx");
    expect(panels).toContain('value: "household", label: "Household reminders"');
    expect(panels).not.toContain('value: "payments", label: "Payment reminders"');
    expect(src("settings-module-page.tsx")).toContain('useState<ResidentSettingsArea>("household")');
  });

  it("Payments list no longer has a separate setup wrench", () => {
    const payments = src("pro-payments.tsx");
    expect(payments).not.toContain('data-attr="payments-setup"');
    expect(payments).not.toContain("paymentsSetupButton");
    expect(payments).toContain("paymentsSettingsMenu");
  });

  it("Operations order is Communication, then Payments, Services, Tasks, Bookings, Inspections, Reminders", () => {
    const profile = src("portal-profile-client.tsx");
    expect(profile).toMatch(/id: "messaging"[\s\S]*?group: "Operations"/);
    const opsPush = profile.slice(profile.indexOf('id: "payments", label: "Payments"'));
    const ids = [...opsPush.matchAll(/id: "(payments|services|tasks|bookings|inspections|reminders)"/g)].map(
      (m) => m[1],
    );
    expect(ids.slice(0, 6)).toEqual([
      "payments",
      "services",
      "tasks",
      "bookings",
      "inspections",
      "reminders",
    ]);
  });
});
