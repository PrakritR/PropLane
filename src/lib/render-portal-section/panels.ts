import type { ManagerInspectionsPage, ResidentInspectionsPage } from "@/components/portal/inspections-panel";
import type { AdminDashboard } from "@/components/portal/admin-dashboard";
import type { ManagerDashboard } from "@/components/portal/pro-dashboard";
import type { ManagerLeases } from "@/components/portal/pro-leases";
import type { ManagerPayments } from "@/components/portal/pro-payments";
import type { ManagerPromotion } from "@/components/portal/pro-promotion";
import type { ManagerMobileAppPanel } from "@/components/portal/pro-mobile-app-panel";
import type { ManagerProfile } from "@/components/portal/pro-profile";
import type { AdminCreateManagerClient } from "@/components/portal/admin-create-manager-client";
import type { AdminCreateResidentClient } from "@/components/portal/admin-create-resident-client";
import type { AdminAxisUsersClient } from "@/components/portal/admin-axis-users-client";
import type { AdminTestWorkspacesClient } from "@/components/portal/admin-test-workspaces-client";
import type { AdminPropertiesClient } from "@/components/portal/admin-properties-client";
import type { AdminEventsClient } from "@/components/portal/admin-events-client";
import type { AdminProfileSection } from "@/components/portal/admin-profile-section";
import type { AdminCommunication } from "@/components/portal/admin-communication";
import type { AdminBugFeedbackClient } from "@/components/portal/admin-bug-feedback-client";
import type { AdminHealthClient } from "@/components/portal/admin-health-client";
import type { ResidentDashboard } from "@/components/portal/resident-dashboard";
import type { ResidentMoveInPanel } from "@/components/portal/resident-move-in-panel";
import type { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import type { ResidentFormsSection } from "@/components/portal/move-in-forms/resident-move-in-forms";
import type { ResidentCommunication } from "@/components/portal/resident-communication";
import type { VendorCommunication } from "@/components/portal/vendor-communication";
import type { ResidentPaymentsPanel } from "@/components/portal/resident-payments-panel";
import type { ResidentDocumentsPanel } from "@/components/portal/resident-documents-panel";
import type { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";
import type { ResidentTourPanel } from "@/components/portal/resident-tour-panel";
import type { ResidentLeasePanel } from "@/components/portal/resident-lease-panel";
import type { ResidentProfileSection } from "@/components/portal/resident-profile-section";
import type { PortalBugFeedbackPanel } from "@/components/portal/portal-bug-feedback-panel";
import type { VendorDashboard } from "@/components/portal/vendor-dashboard";
import type { VendorWorkOrdersPanel } from "@/components/portal/vendor-work-orders-panel";
import type { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";
import type { VendorBalancePanel, VendorWithdrawalDetail } from "@/components/portal/vendor-finances-balance";
import type { VendorRefundsPanel } from "@/components/portal/vendor-refunds-panel";
import type { VendorStatementsPanel } from "@/components/portal/vendor-statements-panel";
import type { VendorTaxPanel } from "@/components/portal/vendor-tax-panel";
import type { VendorDocumentsPanel } from "@/components/portal/vendor-documents-panel";
import type { VendorSettingsPanel } from "@/components/portal/vendor-settings-panel";
import type { VendorReviewsPanel } from "@/components/portal/vendor-reviews-panel";
import type { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import type {
  loadManagerAllServicesPanel,
  loadManagerTaskList,
  loadManagerTours,
  loadManagerBookings,
  loadManagerApplications,
  loadManagerDocumentsPanel,
  loadManagerFinancesPanel,
  loadManagerCommunication,
  loadManagerFormsPage,
  loadManagerProperties,
  loadManagerResidents,
  loadManagerVendorsPanel,
  loadPortalCalendar,
  loadResidentServicesPanel,
} from "@/lib/portal-panel-imports";

/**
 * Every panel the shared renderer (`../render-portal-section.tsx`) can mount. This file is
 * types only. Each portal's module supplies the subset its own screens use, so a page's module
 * graph carries its own panels and no other portal's.
 */
export type PortalPanels = Partial<{
  ManagerInspectionsPage: typeof ManagerInspectionsPage;
  ResidentInspectionsPage: typeof ResidentInspectionsPage;
  AdminDashboard: typeof AdminDashboard;
  ManagerDashboard: typeof ManagerDashboard;
  ManagerLeases: typeof ManagerLeases;
  ManagerPayments: typeof ManagerPayments;
  ManagerPromotion: typeof ManagerPromotion;
  ManagerMobileAppPanel: typeof ManagerMobileAppPanel;
  ManagerProfile: typeof ManagerProfile;
  AdminCreateManagerClient: typeof AdminCreateManagerClient;
  AdminCreateResidentClient: typeof AdminCreateResidentClient;
  AdminAxisUsersClient: typeof AdminAxisUsersClient;
  AdminTestWorkspacesClient: typeof AdminTestWorkspacesClient;
  AdminPropertiesClient: typeof AdminPropertiesClient;
  AdminEventsClient: typeof AdminEventsClient;
  AdminProfileSection: typeof AdminProfileSection;
  AdminCommunication: typeof AdminCommunication;
  AdminBugFeedbackClient: typeof AdminBugFeedbackClient;
  AdminHealthClient: typeof AdminHealthClient;
  ResidentDashboard: typeof ResidentDashboard;
  ResidentMoveInPanel: typeof ResidentMoveInPanel;
  ResidentMoveInShell: typeof ResidentMoveInShell;
  ResidentFormsSection: typeof ResidentFormsSection;
  ResidentCommunication: typeof ResidentCommunication;
  VendorCommunication: typeof VendorCommunication;
  ResidentPaymentsPanel: typeof ResidentPaymentsPanel;
  ResidentDocumentsPanel: typeof ResidentDocumentsPanel;
  ResidentApplicationsPanel: typeof ResidentApplicationsPanel;
  ResidentTourPanel: typeof ResidentTourPanel;
  ResidentLeasePanel: typeof ResidentLeasePanel;
  ResidentProfileSection: typeof ResidentProfileSection;
  PortalBugFeedbackPanel: typeof PortalBugFeedbackPanel;
  VendorDashboard: typeof VendorDashboard;
  VendorWorkOrdersPanel: typeof VendorWorkOrdersPanel;
  VendorFinancesPanel: typeof VendorFinancesPanel;
  VendorBalancePanel: typeof VendorBalancePanel;
  VendorWithdrawalDetail: typeof VendorWithdrawalDetail;
  VendorRefundsPanel: typeof VendorRefundsPanel;
  VendorStatementsPanel: typeof VendorStatementsPanel;
  VendorTaxPanel: typeof VendorTaxPanel;
  VendorDocumentsPanel: typeof VendorDocumentsPanel;
  VendorSettingsPanel: typeof VendorSettingsPanel;
  VendorReviewsPanel: typeof VendorReviewsPanel;
  ManagerPortalPageShell: typeof ManagerPortalPageShell;
  loadManagerAllServicesPanel: typeof loadManagerAllServicesPanel;
  loadManagerTaskList: typeof loadManagerTaskList;
  loadManagerTours: typeof loadManagerTours;
  loadManagerBookings: typeof loadManagerBookings;
  loadManagerApplications: typeof loadManagerApplications;
  loadManagerDocumentsPanel: typeof loadManagerDocumentsPanel;
  loadManagerFinancesPanel: typeof loadManagerFinancesPanel;
  loadManagerCommunication: typeof loadManagerCommunication;
  loadManagerFormsPage: typeof loadManagerFormsPage;
  loadManagerProperties: typeof loadManagerProperties;
  loadManagerResidents: typeof loadManagerResidents;
  loadManagerVendorsPanel: typeof loadManagerVendorsPanel;
  loadPortalCalendar: typeof loadPortalCalendar;
  loadResidentServicesPanel: typeof loadResidentServicesPanel;
  loadManagerOutgoingInvoicesPanel: () => Promise<
    typeof import("@/components/portal/manager-outgoing-invoices-panel").ManagerOutgoingInvoicesPanel
  >;
  /** Server-rendered QR for the desktop-to-phone handoff on the manager App page. */
  buildManagerAppQrSvg: () => Promise<string>;
}>;
