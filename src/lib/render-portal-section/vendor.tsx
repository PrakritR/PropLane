import { VendorCommunication } from "@/components/portal/vendor-communication";
import { VendorDashboard } from "@/components/portal/vendor-dashboard";
import { VendorDocumentsPanel } from "@/components/portal/vendor-documents-panel";
import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";
import { VendorFinancesPage, VendorWithdrawalDetail } from "@/components/portal/vendor-finances-balance";
import { VendorOutgoingPaymentsPanel } from "@/components/portal/vendor-outgoing-payments-panel";
import { VendorReviewsPanel } from "@/components/portal/vendor-reviews-panel";
import { VendorSettingsPanel } from "@/components/portal/vendor-settings-panel";
import { VendorStatementsPanel } from "@/components/portal/vendor-statements-panel";
import { VendorTaxPanel } from "@/components/portal/vendor-tax-panel";
import { VendorWorkOrdersPanel } from "@/components/portal/vendor-work-orders-panel";
import { renderPortalSectionWith, type PortalSearchParams } from "@/lib/render-portal-section";
import type { PortalPanels } from "@/lib/render-portal-section/panels";

export type { PortalSearchParams };

// Imported here rather than through `portal-panel-imports`, which lists every manager panel.
const loadPortalCalendar = async () => (await import("@/components/portal/portal-calendar")).PortalCalendar;

const panels: PortalPanels = {
  VendorCommunication,
  VendorDashboard,
  VendorDocumentsPanel,
  VendorFinancesPanel,
  VendorFinancesPage,
  VendorWithdrawalDetail,
  VendorOutgoingPaymentsPanel,
  VendorReviewsPanel,
  VendorSettingsPanel,
  VendorStatementsPanel,
  VendorTaxPanel,
  VendorWorkOrdersPanel,
  loadPortalCalendar,
};

export async function renderPortalSection(
  kind: "vendor",
  section: string,
  tabParts?: string[],
  searchParams?: PortalSearchParams,
) {
  return renderPortalSectionWith(panels, kind, section, tabParts, searchParams);
}
