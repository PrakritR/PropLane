import { AccountLinksSync } from "@/components/portal/account-links-sync";
import { LandlordLegalNameCacheSync } from "@/components/portal/landlord-legal-name-cache-sync";
import { PropertyPipelineAccountSync } from "@/components/portal/property-pipeline-account-sync";
import { AxisAssistant } from "@/components/portal/axis-assistant";
import { PortalAssistantDockRail } from "@/components/portal/portal-assistant-dock-rail";
import { PortalDataPrefetch } from "@/components/portal/portal-data-prefetch";
import { ManagerPlanBanner } from "@/components/portal/pro-plan-banner";
import { PortalMobileNavBar } from "@/components/portal/portal-mobile-nav-bar";
import { PortalSessionKeepalive } from "@/components/portal/portal-session-keepalive";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { PortalHorizontalScrollRoot } from "@/components/portal/portal-horizontal-scroll";
import { PortalSkipLink } from "@/components/portal/portal-skip-link";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { PublicHomePrefetch } from "@/components/layout/public-home-prefetch";
import { SurfaceThemeDefault } from "@/components/providers/theme-provider";
import { assertPropertyPortalAccess } from "@/lib/auth/portal-access";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import {
  PORTAL_MAIN_CONTENT_CLASS,
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MAIN_CONTENT_INNER_CLASS,
  PORTAL_SHELL_ROOT_CLASS,
} from "@/lib/portal-layout-classes";
import { buildProPortalDefinition } from "@/lib/portals/pro-nav";
import { getAssistantDockCollapsed } from "@/lib/assistant-dock-state";
import { getSidebarCollapsed } from "@/lib/portal-sidebar-state";

export default async function PropertyPortalLayout({ children }: { children: React.ReactNode }) {
  // A production admin (founder/ops) identity must not cross into the property
  // portal even by typing the URL — hiding the switch is not access control.
  await assertPropertyPortalAccess();

  const [nav, { profile }, sidebarCollapsed, assistantDockCollapsed] = await Promise.all([
    buildProPortalDefinition(),
    getServerSessionProfile(),
    getSidebarCollapsed(),
    getAssistantDockCollapsed(),
  ]);

  return (
    <AxisAssistant managerName={profile?.full_name ?? null} dockable>
      <div className={PORTAL_SHELL_ROOT_CLASS}>
        <SurfaceThemeDefault theme="light" />
        <PublicHomePrefetch />
        <PortalDataPrefetch kind="pro" />
        <PortalSessionKeepalive />
        <LandlordLegalNameCacheSync />
        <PropertyPipelineAccountSync />
        <AccountLinksSync />
        <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
          <PortalSkipLink />
          <PortalSidebar
            definition={nav.definition}
            subscriptionTier={nav.subscriptionTier}
            subtitle={nav.planLabel}
            initialCollapsed={sidebarCollapsed}
          />
          <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <PortalTopBar
              kind={nav.definition.kind}
              basePath={nav.definition.basePath}
              name={profile?.full_name ?? null}
              email={profile?.email ?? null}
            />
            {/* `showPlanBanner` has been computed for this all along; nothing
                rendered it, so a lapsed trial took residents, leases, inbox and
                co-managers away without a word (AXI-129). */}
            {nav.showPlanBanner ? (
              <ManagerPlanBanner lapsedFromTrial={nav.planLapsedFromTrial} />
            ) : null}
            <main id={PORTAL_MAIN_CONTENT_ID} tabIndex={-1} className={PORTAL_MAIN_CONTENT_CLASS}>
              <PortalHorizontalScrollRoot>
                <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>
                  <PortalMobileNavBar
                    definition={nav.definition}
                    name={profile?.full_name ?? null}
                    email={profile?.email ?? null}
                  />
                  {children}
                </div>
              </PortalHorizontalScrollRoot>
            </main>
          </div>
          {/* Opt-in, desktop-only assistant rail. Renders nothing on the `popup`
              default, so the content column above keeps the full width. */}
          <PortalAssistantDockRail
            managerName={profile?.full_name ?? null}
            initialCollapsed={assistantDockCollapsed}
          />
        </div>
      </div>
    </AxisAssistant>
  );
}
