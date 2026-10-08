import { AxisAssistant } from "@/components/portal/axis-assistant";
import { PortalAssistantRail } from "@/components/portal/portal-assistant-rail";
import { RateAppPrompt } from "@/components/native/rate-app-prompt";
import { PendingServiceLinkRedeemer } from "@/components/vendor/pending-service-link-redeemer";
import { PortalClientSessionGuard } from "@/components/portal/portal-client-session-guard";
import { PortalDataPrefetch } from "@/components/portal/portal-data-prefetch";
import { PortalMobileNavBar } from "@/components/portal/portal-mobile-nav-bar";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { PortalSkipLink } from "@/components/portal/portal-skip-link";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { PortalWorkspaceRail } from "@/components/portal/portal-workspace-rail";
import { VendorMessagingSetupBanner } from "@/components/portal/vendor-messaging-setup-banner";
import { SurfaceThemeDefault } from "@/components/providers/theme-provider";
import {
  PORTAL_MAIN_CONTENT_CLASS,
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MAIN_CONTENT_INNER_CLASS,
  PORTAL_SHELL_ROOT_CLASS,
} from "@/lib/portal-layout-classes";
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { assertPortalLayoutRole } from "@/lib/auth/portal-layout-guard";
import { vendorPortal } from "@/lib/portals/vendor";
import { getSidebarCollapsed } from "@/lib/portal-sidebar-state";
import { getAssistantDockCollapsed, getAssistantDocked } from "@/lib/assistant-dock-state";
import { ViewAsBanner } from "@/components/portal/view-as-banner";
import { getViewAsBannerState } from "@/lib/auth/view-as-banner.server";

export default async function VendorLayout({ children }: { children: React.ReactNode }) {
  await assertPortalLayoutRole("vendor", "vendor");

  const { profile } = await getEffectiveSessionForPortal("vendor");
  const [sidebarCollapsed, assistantDockCollapsed, assistantDocked] = await Promise.all([
    getSidebarCollapsed(),
    getAssistantDockCollapsed(),
    getAssistantDocked(),
  ]);

  // A "View as" support session: banner on top, assistant and its rail off.
  const viewAs = await getViewAsBannerState();

  return (
    <AxisAssistant endpoint="/api/agent/vendor-chat" managerName={profile?.full_name ?? null} disabled={Boolean(viewAs)}>
    <div className={PORTAL_SHELL_ROOT_CLASS}>
      {viewAs ? <ViewAsBanner {...viewAs} /> : null}
      <SurfaceThemeDefault theme="light" />
      <PortalDataPrefetch kind="vendor" />
      <PortalClientSessionGuard />
      <PendingServiceLinkRedeemer />
      <RateAppPrompt reporterRole="vendor" />
      <PortalTopBar
        kind={vendorPortal.kind}
        basePath={vendorPortal.basePath}
        definition={vendorPortal}
        subscriptionTier={null}
        initialSidebarCollapsed={sidebarCollapsed}
        name={profile?.full_name ?? null}
        email={profile?.email ?? null}
      />
      <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
        <PortalSkipLink />
        <PortalWorkspaceRail
          kind={vendorPortal.kind}
          basePath={vendorPortal.basePath}
          name={profile?.full_name ?? null}
          email={profile?.email ?? null}
        />
        <PortalSidebar
          definition={vendorPortal}
          subscriptionTier={null}
          subtitle="Vendor"
          initialCollapsed={sidebarCollapsed}
        />
        <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <VendorMessagingSetupBanner />
          <main id={PORTAL_MAIN_CONTENT_ID} tabIndex={-1} className={PORTAL_MAIN_CONTENT_CLASS}>
            <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>
              <PortalMobileNavBar
                definition={vendorPortal}
                name={profile?.full_name ?? null}
                email={profile?.email ?? null}
              />
              {children}
            </div>
          </main>
        </div>
        {viewAs ? null : (
          <PortalAssistantRail
            managerName={profile?.full_name ?? null}
            endpoint="/api/agent/vendor-chat"
            initialCollapsed={assistantDockCollapsed}
            initialDocked={assistantDocked}
          />
        )}
      </div>
    </div>
    </AxisAssistant>
  );
}
