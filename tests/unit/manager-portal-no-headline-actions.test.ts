/**
 * Nothing sits above a manager list but the app bar (PLAN-0914-1345).
 *
 * The "+ Add …" button used to float alone in a headline row whose title was
 * hidden — 56px of band with one button in the corner on thirteen sections.
 * Every section's primary now rides the list command bar as the filled
 * circle. This pins the sweep: no manager page hands the shell a
 * `primaryAction`, the old pill constant is gone, and each list bar owns a
 * `primary`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL_DIR = join(process.cwd(), "src/components/portal");
const portalSource = (file: string) => readFileSync(join(PORTAL_DIR, file), "utf8");

const MANAGER_LIST_PAGES = [
  "pro-properties.tsx",
  "pro-tours.tsx",
  "pro-leases.tsx",
  "pro-residents.tsx",
  "pro-all-services-panel.tsx",
  "pro-task-list.tsx",
  "pro-payments.tsx",
  "pro-bookings.tsx",
  "pro-documents-panel.tsx",
  "pro-promotion.tsx",
  "pro-vendors-panel.tsx",
  "pro-account-links-panel.tsx",
  "pro-applications.tsx",
  "inspections-panel.tsx",
  "pro-communication.tsx",
  "pro-dashboard.tsx",
];

describe("manager list chrome: no headline-row buttons", () => {
  it("no manager page passes primaryAction to the page shell", () => {
    for (const file of MANAGER_LIST_PAGES) {
      expect(portalSource(file), file).not.toMatch(/\bprimaryAction=/);
    }
    expect(portalSource("portal-metrics.tsx")).not.toContain("primaryAction?: ReactNode;\n  /** Filter pill");
  });

  it("the headline pill constant no longer exists", () => {
    expect(portalSource("portal-icon-action.tsx")).not.toContain("PORTAL_PAGE_PRIMARY_ACTION_BTN");
    for (const file of MANAGER_LIST_PAGES) {
      expect(portalSource(file), file).not.toContain("PORTAL_PAGE_PRIMARY_ACTION_BTN");
    }
  });

  it("every list section's primary is the filled circle in the command bar", () => {
    const withPrimary = [
      "pro-properties.tsx",
      "pro-tours.tsx",
      "pro-leases.tsx",
      "pro-residents.tsx",
      "pro-all-services-panel.tsx",
      "pro-task-list.tsx",
      "pro-payments.tsx",
      "pro-bookings.tsx",
      "pro-documents-panel.tsx",
      "pro-promotion.tsx",
      "pro-vendors-panel.tsx",
    ];
    for (const file of withPrimary) {
      const src = portalSource(file);
      expect(src, file).toContain("PortalPrimaryIconAction");
      expect(src, file).toMatch(/\bprimary=\{/);
    }
    // Team has one door: its Invite button is published beside the title.
    expect(portalSource("pro-account-links-panel.tsx")).toContain("usePublishTitleActions(titleControls");
    expect(portalSource("pro-account-links-panel.tsx")).toContain('data-attr="co-manager-invite-top"');
    // Communication's primary sits in the conversation-list head instead.
    expect(portalSource("pro-communication.tsx")).toContain("listActions={communicationCommandActions}");
    expect(portalSource("pro-communication.tsx")).not.toContain("titleAside={communicationCommandActions}");
  });

  it("utility controls are icon-only: no visible word branch remains", () => {
    const src = portalSource("portal-icon-action.tsx");
    expect(src).not.toContain('hidden md:inline');
    expect(src).not.toContain("visibleWord(");
  });

  it("the dashed '+ Add' row is gone from Promotion, Vendors and Documents", () => {
    for (const file of ["pro-promotion.tsx", "pro-vendors-panel.tsx", "pro-documents-leasing-tabs.tsx", "pro-document-library.tsx"]) {
      expect(portalSource(file), file).not.toContain("<PortalListAddRow");
    }
  });
});
