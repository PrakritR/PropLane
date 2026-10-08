import { AdminAxisUsersClient } from "@/components/portal/admin-axis-users-client";
import { AdminBugFeedbackClient } from "@/components/portal/admin-bug-feedback-client";
import { AdminCommunication } from "@/components/portal/admin-communication";
import { AdminCreateManagerClient } from "@/components/portal/admin-create-manager-client";
import { AdminCreateResidentClient } from "@/components/portal/admin-create-resident-client";
import { AdminDashboard } from "@/components/portal/admin-dashboard";
import { AdminEventsClient } from "@/components/portal/admin-events-client";
import { GrowthAdminClient } from "@/components/portal/growth-admin-client";
import { AdminHealthClient } from "@/components/portal/admin-health-client";
import { AdminProfileSection } from "@/components/portal/admin-profile-section";
import { AdminPropertiesClient } from "@/components/portal/admin-properties-client";
import { AdminTestWorkspacesClient } from "@/components/portal/admin-test-workspaces-client";
import { renderPortalSectionWith, type PortalSearchParams } from "@/lib/render-portal-section";
import type { PortalPanels } from "@/lib/render-portal-section/panels";

export type { PortalSearchParams };

const panels: PortalPanels = {
  AdminAxisUsersClient,
  AdminBugFeedbackClient,
  AdminCommunication,
  AdminCreateManagerClient,
  AdminCreateResidentClient,
  AdminDashboard,
  AdminEventsClient,
  AdminHealthClient,
  GrowthAdminClient,
  AdminProfileSection,
  AdminPropertiesClient,
  AdminTestWorkspacesClient,
};

export async function renderPortalSection(
  kind: "admin",
  section: string,
  tabParts?: string[],
  searchParams?: PortalSearchParams,
) {
  return renderPortalSectionWith(panels, kind, section, tabParts, searchParams);
}
