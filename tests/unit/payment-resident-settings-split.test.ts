import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL = join(process.cwd(), "src/components/portal");

function src(file: string) {
  return readFileSync(join(PORTAL, file), "utf8");
}

describe("Payment settings owns setup; Residents drop rent reminders", () => {
  it("Payment settings shows setup and links the account processing default; no late-fee default", () => {
    // PLAN-0920-0845 phase E: the "Settings" area dropdown (one area shown at
    // a time) is gone — every area is now its own always-visible, titled
    // section, in this order.
    const panels = src("pro-portal-settings-panels.tsx");
    expect(panels).toContain('title="Payment setup"');
    expect(panels).toContain('label="Processing fee paid by"');
    expect(panels).not.toContain('title="Late fees"');
    expect(panels).not.toContain('title="Incoming reminders"');
    expect(panels).not.toContain('title="Outgoing reminders"');
    expect(panels).not.toContain('value: "rent", label: "Rent reminders"');
    expect(panels).not.toContain("PAYMENTS_SETTINGS_AREAS");
    expect(panels).not.toContain('dataAttr="payments-settings-area"');
    expect(panels).toContain('/portal/profile?tab=account');

    const hub = src("pro-portal-automation-settings-panel.tsx");
    expect(hub).toContain("IncomingPaymentRemindersSettingsBundle");
    expect(hub).toContain("OutgoingPaymentRemindersSettingsBundle");
  });

  it("Resident settings' welcome reminder moved to the Reminders hub, not rent reminders", () => {
    const panels = src("pro-portal-settings-panels.tsx");
    expect(panels).not.toContain('kind: "resident_welcome"');
    expect(panels).not.toContain('value: "payments", label: "Payment reminders"');

    const hub = src("pro-portal-automation-settings-panel.tsx");
    expect(hub).toContain('kind: "resident_welcome"');
  });

  it("Payments list no longer has a separate setup wrench", () => {
    const payments = src("pro-payments.tsx");
    expect(payments).not.toContain('data-attr="payments-setup"');
    expect(payments).not.toContain("paymentsSetupButton");
    expect(payments).toContain("paymentsSettingsMenu");
  });

  it("Workspace settings keep Communication, one Payments page, and Integrations", () => {
    const profile = src("portal-profile-client.tsx");
    expect(profile).toMatch(/id: "messaging"[\s\S]*?group: "Workspace"/);
    const opsPush = profile.slice(profile.indexOf('id: "payments", label: "Payments"'));
    const ids = [...opsPush.matchAll(/id: "(payments|payouts|spreadsheets|services|tasks|bookings|inspections|reminders)"/g)].map(
      (m) => m[1],
    );
    expect(ids).toEqual(["payments", "spreadsheets"]);
    expect(opsPush).not.toContain('id: "payouts"');
    expect(opsPush).not.toContain('id: "applicationForm"');
    expect(opsPush).not.toContain('id: "leaseDocuments"');
    expect(profile).toContain('<HubSettingsModulePane tab="payouts" />');
  });
});
