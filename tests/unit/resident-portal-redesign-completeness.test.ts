import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS,
  RESIDENT_APPROVED_PORTAL_SECTIONS,
  RESIDENT_LIMITED_PORTAL_SECTIONS,
} from "@/lib/portals/resident-sections";
import { isResidentApplicationPhaseAllowedPath } from "@/lib/resident-portal-route-guard";

const ROOT = join(process.cwd(), "src/components/portal");

function readPanel(filename: string): string {
  return readFileSync(join(ROOT, filename), "utf8");
}

function sectionIds(sections: { section: string }[]): string[] {
  return sections.map((s) => s.section);
}

describe("resident portal redesign completeness", () => {
  describe("three access-state section catalogs", () => {
    it("application phase exposes tour, application, dashboard, and communication", () => {
      expect(sectionIds(RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS)).toEqual([
        "tour",
        "applications",
        "dashboard",
        "communication",
        "profile",
      ]);
    });

    it("limited workspace includes dashboard and omits services", () => {
      const ids = sectionIds(RESIDENT_LIMITED_PORTAL_SECTIONS);
      expect(ids).toContain("dashboard");
      expect(ids).not.toContain("services");
      expect(ids).toContain("communication");
    });

    it("post-lease workspace leads with services and payments", () => {
      const ids = sectionIds(RESIDENT_APPROVED_PORTAL_SECTIONS);
      expect(ids[0]).toBe("services");
      expect(ids[1]).toBe("payments");
      expect(ids).toContain("dashboard");
      expect(ids).toContain("communication");
    });

    it("pre-lease workspace includes payments and omits services", () => {
      const ids = sectionIds(RESIDENT_LIMITED_PORTAL_SECTIONS);
      expect(ids).not.toContain("services");
      expect(ids).toContain("payments");
      expect(ids).toContain("applications");
      expect(ids).toContain("lease");
      expect(ids).toContain("dashboard");
    });

    it("application-phase route guard allows communication and dashboard", () => {
      expect(isResidentApplicationPhaseAllowedPath("/resident/communication/inbox/unopened")).toBe(true);
      expect(isResidentApplicationPhaseAllowedPath("/resident/dashboard")).toBe(true);
      expect(isResidentApplicationPhaseAllowedPath("/resident/tour")).toBe(true);
      expect(isResidentApplicationPhaseAllowedPath("/resident/profile")).toBe(true);
      expect(isResidentApplicationPhaseAllowedPath("/resident/lease")).toBe(false);
    });
  });

  describe("no navigation/sort/filter dropdowns in production resident panels", () => {
    const productionPanels = [
      "resident-dashboard.tsx",
      "resident-applications-panel.tsx",
      "resident-lease-panel.tsx",
      "resident-payments-panel.tsx",
      "resident-move-in-panel.tsx",
      "resident-move-in-view.tsx",
      "resident-services-panel.tsx",
      "resident-communication.tsx",
      "resident-documents-panel.tsx",
      "resident-profile-panel.tsx",
    ];

    it.each(productionPanels)("%s does not use TabNav or FilterBar for navigation", (file) => {
      const src = readPanel(file);
      expect(src).not.toMatch(/\bTabNav\b/);
      expect(src).not.toMatch(/\bFilterBar\b/);
      expect(src).not.toMatch(/\bDropdownMenu\b/);
    });

    it("services uses LocalDestinationNav for status filters, not mobile dropdowns", () => {
      const src = readPanel("resident-services-panel.tsx");
      expect(src).toContain("LocalDestinationNav");
      expect(src).not.toMatch(/\bPillTabs\b/);
      expect(src).not.toMatch(/Filter & sort/);
    });

    it("hideTitleOnMobileNav keeps section actions off the mobile PageHeader row", () => {
      const src = readFileSync(
        join(process.cwd(), "src/components/portal/portal-metrics.tsx"),
        "utf8",
      );
      expect(src).toMatch(/useInlineTitleBand[\s\S]*hideTitleOnMobileNav/);
      expect(src).toMatch(
        /titleAsideDesktopOnly[\s\S]*Boolean\(titleAside && hideTitleOnMobileNav && !useInlineTitleBand\)/,
      );
      expect(src).toMatch(/primaryAction=\{titleAside && !titleAsideDesktopOnly/);
      expect(src).toContain("showMobileFooterActions = titleAsideDesktopOnly");
    });

    it("legacy inbox panel folder tabs are not mounted from resident-communication", () => {
      const src = readPanel("resident-communication.tsx");
      expect(src).toContain("ResidentUnifiedInbox");
      expect(src).not.toMatch(/\bTabNav\b/);
    });
  });

  describe("three-band header contract on list sections", () => {
    const band2Panels: Array<{ file: string; marker: string }> = [
      { file: "resident-applications-panel.tsx", marker: "PortalListControlStack" },
      { file: "resident-payments-panel.tsx", marker: "PortalListControlStack" },
      { file: "resident-documents-panel.tsx", marker: "PortalListControlStack" },
      { file: "resident-services-panel.tsx", marker: "PortalListControlStack" },
    ];

    it.each(band2Panels)("%s uses %s for band-2 tabs", ({ file, marker }) => {
      expect(readPanel(file)).toContain(marker);
    });

    it("list sections hide duplicate mobile titles on page shells", () => {
      const shellPanels = [
        "resident-applications-panel.tsx",
        "resident-lease-panel.tsx",
        "resident-payments-panel.tsx",
        "resident-services-panel.tsx",
        "resident-documents-panel.tsx",
        "resident-dashboard.tsx",
        "resident-profile-panel.tsx",
        "resident-move-in-panel.tsx",
      ];
      for (const file of shellPanels) {
        expect(readPanel(file)).toContain("hideTitleOnMobileNav");
      }
    });

    it("communication uses PortalCommunicationShell with inline title band (filter + actions on title row)", () => {
      const src = readPanel("resident-communication.tsx");
      expect(src).toContain("PortalCommunicationShell");
      // The panel carries "New message" on the title band, but in the SPLIT shape
      // rather than band-only: a `hidden md:flex` titleAside plus an `md:hidden`
      // row in the control stack. Both shapes are valid per rule 3 of
      // docs/portal-list-section-layout.md, and split is what this panel needs —
      // the phone button uses the responsive variant and is suppressed while a
      // thread is open (`!threadOpen`), neither of which a single shared node can
      // express. Asserting band-only here contradicted
      // `portal-inline-title-band-duplicate-controls.test.tsx`, which is the guard
      // that actually enforces "header actions reach a phone exactly once" — so
      // that one owns the shape, and this one just checks the button is present.
      expect(src).toContain('data-attr="communication-new-message"');
      expect(src).toContain("PortalTextNotificationsBlock");
      expect(src).toContain("communicationSettingsOpen");
      expect(src).not.toContain("PortalFilterSortSheet");
      expect(src).not.toContain("PortalPageHeaderMobileActionsRow");
    });

    it("dashboard uses manager-style attention groups without welcome subtitle", () => {
      const src = readPanel("resident-dashboard.tsx");
      expect(src).toContain("AttentionGroup");
      expect(src).toContain("Needs attention");
      expect(src).not.toMatch(/subtitle=\{?["'].*[Ww]elcome/);
      expect(src).toContain("hideTitleOnMobileNav");
    });

    it("dashboard openCount respects customize visibility", () => {
      const src = readPanel("resident-dashboard.tsx");
      expect(src).toMatch(/canUsePayments && visibility\.payments \? pendingCharges\.length : 0/);
      // Operand order is not the contract — that the services term is gated on
      // BOTH the capability and the customize toggle is. The panel currently
      // writes `canUseServices && visibility.services`; pinning one order made a
      // no-op refactor red.
      expect(src).toMatch(
        /(canUseServices && visibility\.services|visibility\.services && canUseServices)/,
      );
      expect(src).toMatch(/showHouseDetails/);
      expect(src).toMatch(/visibility\.communication \? inbox : 0/);
    });
  });

  describe("390px mobile density sweep", () => {
    it("unlock and tier gates use compact inline notices, not glass cards", () => {
      const unlockSurfaces = [
        readPanel("resident-payments-panel.tsx"),
        readPanel("resident-services-panel.tsx"),
        readPanel("resident-move-in-view.tsx"),
        readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8"),
      ];
      for (const src of unlockSurfaces) {
        expect(src).toContain("PORTAL_INLINE_UNLOCK_NOTICE_CLASS");
        expect(src).not.toMatch(/glass-card.*unlock/i);
      }
      expect(readPanel("resident-payments-panel.tsx")).not.toContain("glass-card");
      expect(readPanel("resident-lease-panel.tsx")).not.toContain("glass-card");
    });

    it("house details uses routed sub-tabs with command layout", () => {
      const moveIn = readPanel("resident-move-in-view.tsx");
      expect(moveIn).toContain("PortalListControlStack");
      expect(moveIn).toContain('variant="command"');
      expect(moveIn).toContain("RESIDENT_MOVE_IN_TABS");
      expect(moveIn).toContain("RESIDENT_MOVE_IN_TAB_LABELS");
      expect(moveIn).toContain("RESIDENT_MOVE_IN_TAB_SHORT_LABELS");
      expect(moveIn).toContain("destinationDenseEqualRow");
      expect(moveIn).toContain("residentMoveInHref");
      expect(moveIn).toContain("Assigned room");
      expect(moveIn).toContain("InstructionsTabContent");
    });

    it("lease, tour, and applications use command layout with grouped property lists", () => {
      const lease = readPanel("resident-lease-panel.tsx");
      expect(lease).toContain('variant="command"');
      expect(readPanel("resident-lease-list.tsx")).toContain("ResidentPortalGroupedDataList");
      const payments = readPanel("resident-payments-panel.tsx");
      expect(payments).toContain('variant="command"');
      expect(payments).toContain("ResidentPortalGroupedDataList");
      const tour = readPanel("resident-tour-panel.tsx");
      expect(tour).toContain('variant="command"');
      expect(tour).toContain("ResidentPortalGroupedDataList");
      expect(tour).toContain("PortalListAddRow");
      const applications = readPanel("resident-applications-panel.tsx");
      expect(applications).toContain('variant="command"');
      expect(applications).toContain("ResidentPortalGroupedDataList");
      expect(applications).not.toContain("useResidentPortalListFilterState");
      const services = readPanel("resident-services-panel.tsx");
      expect(services).toContain('variant="command"');
      expect(services).toContain("ResidentPortalGroupedDataList");
      expect(services).not.toContain("useResidentPortalListFilterState");
    });

    it("lease filter tabs are a local nav, not a dropdown; services filter rows span full width", () => {
      const lease = readPanel("resident-lease-panel.tsx");
      // Routed status buckets render as command destination tabs, not a mobile dropdown.
      expect(lease).toContain('variant="command"');
      expect(lease).toContain("destinationAriaLabel");
      const services = readPanel("resident-services-panel.tsx");
      expect(services).toContain("SERVICE_STATE_TABS");
      expect(services).toContain('ariaLabel="Service status"');
    });

    /**
     * A header action must reach the phone EXACTLY ONCE. There are two correct shapes and
     * mixing them is what shipped two overlapping "Apply to property" / "Schedule a tour"
     * buttons to production:
     *   a) the shell's inline title band carries it at every breakpoint (no mobile row), or
     *   b) a `hidden md:flex` titleAside pairs with an `md:hidden` mobile row.
     * Never both an ungated title band AND a mobile row.
     */
    it("header actions reach mobile exactly once — band OR mobile row, never both", () => {
      // Services uses a dashed list-footer add row, not a command-strip action.
      const services = readPanel("resident-services-panel.tsx");
      expect(services).toContain("ResidentAddServiceModal");
      expect(services).toContain("renderServiceAddRow");
      expect(services).toContain('dataAttr="resident-services-apply"');
      expect(services).toContain('label="Service"');
      expect(services).not.toContain("ResidentServicesAddActions");
      expect(services).not.toContain("PortalPageHeaderMobileActionsRow");

      const tour = readPanel("resident-tour-panel.tsx");
      expect(tour).toContain("renderTourAddRow");
      expect(tour).toContain("PortalListAddRow");
      expect(tour).toContain('label="Schedule tour"');
      expect(tour).not.toContain("useResidentPortalListFilterState");
      expect(tour).not.toContain("titleAside={scheduleTourButton}");
      expect(tour).not.toContain("PortalResidentListFab");
      expect(tour).not.toContain("PortalPageHeaderMobileActionsRow");
      expect(tour).not.toContain("PORTAL_COMMAND_PRIMARY_ACTION_BTN");

      const applications = readPanel("resident-applications-panel.tsx");
      expect(applications).toContain("applicationListControlStack");
      expect(applications).toContain("renderApplicationAddRow");
      expect(applications).toContain('label="Apply"');
      expect(applications).not.toContain("hint={");
      expect(applications).not.toContain("ResidentApplicationWorkspaceActions");
      expect(applications).not.toContain("ResidentApplicationWorkspaceMobileApply");
      expect(applications).not.toContain("PortalPageHeaderMobileActionsRow");

      const lease = readPanel("resident-lease-panel.tsx");
      expect(lease).toContain("leaseDetailFooter");
      expect(lease).toContain("ResidentDocumentsDetailFooter");
      expect(lease).not.toContain("Request edits");
      expect(lease).not.toContain("resident-lease-request-edits");
      expect(lease).not.toContain("PortalPageHeaderMobileActionsRow");
    });

    it("lease renewal uses one modal — renew fields expand in place", () => {
      const amend = readPanel("lease-amend-move-out-modal.tsx");
      expect(amend).toContain("assistantStrip={false}");
      expect(amend).toContain("ModalAssistantStrip");
      expect(amend).toContain('data-attr="lease-amend-intent"');
      expect(amend).toContain('data-attr="lease-amend-extend-type"');
      expect(amend).toContain("activeRenewTerm");
      expect(amend).toContain("Change renewal option");
      expect(amend).not.toContain("extendTypeChipClass");
      const lease = readPanel("resident-lease-panel.tsx");
      expect(lease).toContain("renewUrl: \"/api/resident/renew-lease\"");
      expect(lease).not.toContain("LeaseRenewModal");
      expect(lease).not.toContain("onOpenRenew");
    });

    it("application phase includes dashboard; limited omits services; approved adds it", () => {
      expect(sectionIds(RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS)).toContain("dashboard");
      expect(sectionIds(RESIDENT_LIMITED_PORTAL_SECTIONS)).toContain("dashboard");
      expect(sectionIds(RESIDENT_LIMITED_PORTAL_SECTIONS)).not.toContain("services");
      expect(sectionIds(RESIDENT_APPROVED_PORTAL_SECTIONS)).toContain("services");
      expect(sectionIds(RESIDENT_APPROVED_PORTAL_SECTIONS)).toContain("dashboard");
    });
  });
});
