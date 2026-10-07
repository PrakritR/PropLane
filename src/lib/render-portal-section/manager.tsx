import dynamic from "next/dynamic";
import QRCode from "qrcode";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";
import {
  loadManagerAllServicesPanel,
  loadManagerApplications,
  loadManagerBookings,
  loadManagerCommunication,
  loadManagerDocumentsPanel,
  loadManagerFinancesPanel,
  loadManagerFormsPage,
  loadManagerProperties,
  loadManagerResidents,
  loadManagerTaskList,
  loadManagerTours,
  loadManagerVendorsPanel,
  loadPortalCalendar,
} from "@/lib/portal-panel-imports";
import type { PortalKind } from "@/lib/portal-types";
import { renderPortalSectionWith, type PortalSearchParams } from "@/lib/render-portal-section";
import type { PortalPanels } from "@/lib/render-portal-section/panels";

export type { PortalSearchParams };

type ManagerKind = Extract<PortalKind, "manager" | "pro">;

const loading = () => <ListSkeleton />;

// Each section pulls only its own panel's chunk. The big list/record panels are code-split
// loaders (`portal-panel-imports`, awaited only on the section that needs them); the rest are
// lazy components below.
const panels: PortalPanels = {
  ManagerInspectionsPage: dynamic(
    () => import("@/components/portal/inspections-panel").then((m) => m.ManagerInspectionsPage),
    { loading },
  ) as unknown as PortalPanels["ManagerInspectionsPage"],
  ManagerDashboard: dynamic(
    () => import("@/components/portal/pro-dashboard").then((m) => m.ManagerDashboard),
    { loading },
  ) as unknown as PortalPanels["ManagerDashboard"],
  ManagerLeases: dynamic(
    () => import("@/components/portal/pro-leases").then((m) => m.ManagerLeases),
    { loading },
  ) as unknown as PortalPanels["ManagerLeases"],
  ManagerPayments: dynamic(
    () => import("@/components/portal/pro-payments").then((m) => m.ManagerPayments),
    { loading },
  ) as unknown as PortalPanels["ManagerPayments"],
  ManagerPromotion: dynamic(
    () => import("@/components/portal/pro-promotion").then((m) => m.ManagerPromotion),
    { loading },
  ) as unknown as PortalPanels["ManagerPromotion"],
  ManagerMobileAppPanel: dynamic(
    () => import("@/components/portal/pro-mobile-app-panel").then((m) => m.ManagerMobileAppPanel),
    { loading },
  ) as unknown as PortalPanels["ManagerMobileAppPanel"],
  ManagerProfile: dynamic(
    () => import("@/components/portal/pro-profile").then((m) => m.ManagerProfile),
    { loading },
  ) as unknown as PortalPanels["ManagerProfile"],
  PortalBugFeedbackPanel: dynamic(
    () => import("@/components/portal/portal-bug-feedback-panel").then((m) => m.PortalBugFeedbackPanel),
    { loading },
  ) as unknown as PortalPanels["PortalBugFeedbackPanel"],
  loadManagerAllServicesPanel,
  loadManagerApplications,
  loadManagerBookings,
  loadManagerCommunication,
  loadManagerDocumentsPanel,
  loadManagerFinancesPanel,
  loadManagerFormsPage,
  loadManagerProperties,
  loadManagerResidents,
  loadManagerTaskList,
  loadManagerTours,
  loadManagerVendorsPanel,
  loadPortalCalendar,
  loadManagerOutgoingInvoicesPanel: async () =>
    (await import("@/components/portal/manager-outgoing-invoices-panel")).ManagerOutgoingInvoicesPanel,
  // N068: a real QR code fills the desktop-only blank space next to the phone-dock layout with a
  // fast desktop-to-phone handoff, generated server-side from the same canonical download URL the
  // App Store badge uses (same pattern as the public /app page and the house print sheets).
  buildManagerAppQrSvg: () =>
    QRCode.toString(iosAppDownloadUrl(), {
      type: "svg",
      margin: 0,
      color: { dark: "#0b1120", light: "#ffffff00" },
    }),
};

export async function renderPortalSection(
  kind: ManagerKind,
  section: string,
  tabParts?: string[],
  searchParams?: PortalSearchParams,
) {
  return renderPortalSectionWith(panels, kind, section, tabParts, searchParams);
}

/** Thin server entry for explicit `src/app/portal/**` route files (Appendix E2). */
export async function renderProPortalSection(section: string, tab?: string[]) {
  return renderPortalSection("pro", section, tab);
}
