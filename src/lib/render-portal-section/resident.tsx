import { ResidentInspectionsPage } from "@/components/portal/inspections-panel";
import { ResidentFormsSection } from "@/components/portal/move-in-forms/resident-move-in-forms";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";
import { ResidentCommunication } from "@/components/portal/resident-communication";
import { ResidentDashboard } from "@/components/portal/resident-dashboard";
import { ResidentDocumentsPanel } from "@/components/portal/resident-documents-panel";
import { ResidentLeasePanel } from "@/components/portal/resident-lease-panel";
import { ResidentMoveInPanel } from "@/components/portal/resident-move-in-panel";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import { ResidentPaymentsPanel } from "@/components/portal/resident-payments-panel";
import { ResidentProfileSection } from "@/components/portal/resident-profile-section";
import { ResidentTourPanel } from "@/components/portal/resident-tour-panel";
import { renderPortalSectionWith, type PortalSearchParams } from "@/lib/render-portal-section";
import type { PortalPanels } from "@/lib/render-portal-section/panels";

export type { PortalSearchParams };

// Imported here rather than through `portal-panel-imports`, which lists every manager panel.
const loadResidentServicesPanel = async () =>
  (await import("@/components/portal/resident-services-panel")).ResidentServicesPanel;

const panels: PortalPanels = {
  ManagerPortalPageShell,
  ResidentApplicationsPanel,
  ResidentCommunication,
  ResidentDashboard,
  ResidentDocumentsPanel,
  ResidentFormsSection,
  ResidentInspectionsPage,
  ResidentLeasePanel,
  ResidentMoveInPanel,
  ResidentMoveInShell,
  ResidentPaymentsPanel,
  ResidentProfileSection,
  ResidentTourPanel,
  loadResidentServicesPanel,
};

export async function renderPortalSection(
  kind: "resident",
  section: string,
  tabParts?: string[],
  searchParams?: PortalSearchParams,
) {
  return renderPortalSectionWith(panels, kind, section, tabParts, searchParams);
}

/** Thin server entry for explicit `src/app/resident/**` route files. */
export async function renderResidentPortalSection(section: string, tab?: string[]) {
  return renderPortalSection("resident", section, tab);
}
