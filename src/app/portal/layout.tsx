import { RateAppPrompt } from "@/components/native/rate-app-prompt";
import { AccountLinksSync } from "@/components/portal/account-links-sync";
import { LandlordLegalNameCacheSync } from "@/components/portal/landlord-legal-name-cache-sync";
import { PropertyPipelineAccountSync } from "@/components/portal/property-pipeline-account-sync";
import { AxisAssistant } from "@/components/portal/axis-assistant";
import { PortalAssistantRail } from "@/components/portal/portal-assistant-rail";
import { PortalDataPrefetch } from "@/components/portal/portal-data-prefetch";
import { ManagerMessagingSetupBanner } from "@/components/portal/messaging-setup-banner";
import { ManagerPlanBanner } from "@/components/portal/pro-plan-banner";
import { PortalMobileNavBar } from "@/components/portal/portal-mobile-nav-bar";
import { PortalSessionKeepalive } from "@/components/portal/portal-session-keepalive";
import { PortalClientSessionGuard } from "@/components/portal/portal-client-session-guard";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { PortalHorizontalScrollRoot } from "@/components/portal/portal-horizontal-scroll";
import { PortalSkipLink } from "@/components/portal/portal-skip-link";
import { PortalReadOnlyProvider } from "@/components/portal/portal-read-only";
import { ManagedReadOnlyStrip } from "@/components/portal/managed-read-only-strip";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { PortalWorkspaceRail } from "@/components/portal/portal-workspace-rail";
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
import { isSmsCommUiEnabled } from "@/lib/sms-comm-ui-flag.server";
import { getAssistantDockCollapsed } from "@/lib/assistant-dock-state";
import { getSidebarCollapsed } from "@/lib/portal-sidebar-state";
import { WorkspaceProvider } from "@/components/portal/workspace-provider";
import { ServiceModeProvider } from "@/components/portal/service-mode-context";
import { TestAccountBanner } from "@/components/portal/test-account-banner";
import { TestAccountUnavailable } from "@/components/portal/test-account-unavailable";
import { isTestWorkspaceFeatureEnabled, resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";
import { ViewAsBanner } from "@/components/portal/view-as-banner";
import { cookies } from "next/headers";
import { getPortalAccessContext, hasAdminRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolvePortalServiceShell, type PortalServiceShell } from "@/lib/service/service-mode.server";
import { serviceTopBarLabel } from "@/lib/service/service-mode";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";
import { getViewAsBannerState } from "@/lib/auth/view-as-banner.server";

export default async function PropertyPortalLayout({ children }: { children: React.ReactNode }) {
  // A production admin (founder/ops) identity must not cross into the property
  // portal even by typing the URL — hiding the switch is not access control.
  await assertPropertyPortalAccess();

  // Every account with manager access gets the one manager shell (black top bar, workspace rail, sidebar,
  // assistant rail). There is no separate owner chrome: an owner of a PropLane-managed workspace sees their
  // workspace here, view-only (`workspace.readOnly`, see ManagedReadOnlyStrip).
  const [session, sidebarCollapsed, assistantDockCollapsed] = await Promise.all([
    getServerSessionProfile(),
    getSidebarCollapsed(),
    getAssistantDockCollapsed(),
  ]);

  // The nav definition and the test-workspace classification are independent of each other, so they resolve together.
  // `session` is already resolved (and request-cached), so `user` is known.
  const { profile, user } = session;
  const [navBase, testWorkspace] = await Promise.all([
    buildProPortalDefinition(),
    user ? resolveTestWorkspaceClassification(user.id) : Promise.resolve({ kind: "normal" as const }),
  ]);
  if (testWorkspace.kind === "classified" && (testWorkspace.state !== "active" || !isTestWorkspaceFeatureEnabled())) {
    return <TestAccountUnavailable state={testWorkspace.state} />;
  }

  // A "View as" support session: banner on top, assistant and its side panel off.
  const viewAs = await getViewAsBannerState();

  // Service mode: the active workspace is a PropLane Service workspace this account is staff of. The Property portal
  // is for managers who bought the software; PropLane's managed workspaces open in the admin-style shell instead
  // (same panels and routes, a different rail). Never during a View-as session, never for the client who owns one.
  const isAdminViewer = hasAdminRole(await getPortalAccessContext());
  const serviceShell: PortalServiceShell =
    user && !viewAs
      ? await resolvePortalServiceShell(
          createSupabaseServiceRoleClient(),
          user.id,
          (await cookies()).get(WORKSPACE_COOKIE)?.value,
          isAdminViewer,
        )
      : { mode: "property", staff: [] };
  const service = serviceShell.mode === "service" ? serviceShell : null;
  // Service mode is the service's own plan, not the viewer's: nav locks follow "paid", no upgrade banner, and the
  // sidebar badge names the service instead of the viewer's own tier.
  const nav = service
    ? { ...navBase, showPlanBanner: false, subscriptionTier: "paid" as const, planLabel: "PropLane Service" }
    : navBase;

  return (
    <AxisAssistant managerName={profile?.full_name ?? null} smsTestPortal="manager" disabled={Boolean(viewAs)}>
      <div className={PORTAL_SHELL_ROOT_CLASS}>
        {viewAs ? <ViewAsBanner {...viewAs} /> : null}
        <WorkspaceProvider>
        <PortalReadOnlyProvider>
        <ServiceModeProvider value={{ active: Boolean(service), isAdmin: isAdminViewer }}>
        <SurfaceThemeDefault theme="light" />
        <PortalDataPrefetch kind="pro" />
        <PortalSessionKeepalive />
        <PortalClientSessionGuard />
        <LandlordLegalNameCacheSync />
        <PropertyPipelineAccountSync />
        <AccountLinksSync />
        <RateAppPrompt reporterRole="manager" />
        <PortalTopBar
          kind={nav.definition.kind}
          basePath={nav.definition.basePath}
          definition={nav.definition}
          subscriptionTier={nav.subscriptionTier}
          initialSidebarCollapsed={sidebarCollapsed}
          name={profile?.full_name ?? null}
          email={profile?.email ?? null}
          serviceLabel={service ? serviceTopBarLabel(service.activeName) : undefined}
        />
        <ManagedReadOnlyStrip />
        <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
          <PortalSkipLink />
          <PortalWorkspaceRail
            kind={nav.definition.kind}
            basePath={nav.definition.basePath}
            name={profile?.full_name ?? null}
            email={profile?.email ?? null}
            service={service?.shell}
            serviceEntries={!service && serviceShell.mode === "property" && !isAdminViewer ? serviceShell.staff : undefined}
          />
          <PortalSidebar
            definition={nav.definition}
            subscriptionTier={nav.subscriptionTier}
            subtitle={nav.planLabel}
            initialCollapsed={sidebarCollapsed}
            smsUiEnabled={isSmsCommUiEnabled()}
          />
          <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {testWorkspace.kind === "classified" ? <TestAccountBanner state={testWorkspace.state} /> : null}
            {/* `showPlanBanner` has been computed for this all along; nothing
                rendered it, so a lapsed trial took residents, leases, inbox and
                co-managers away without a word (AXI-129). */}
            {nav.showPlanBanner ? (
              <ManagerPlanBanner lapsedFromTrial={nav.planLapsedFromTrial} />
            ) : null}
            {/* Same slot, every page: without a work number the listing has no
                Text button and no page said why — only the property preview
                tab carried the notice, and a manager who never opens that tab
                never found out. It hides itself for a free account, which is
                already showing the upgrade banner above.
                Desktop-only mount: on phones the mobile header (workspace
                switcher + avatar) must render above this notice, so the phone
                copy mounts inside <main>, right after PortalMobileNavBar,
                instead of here. */}
            <div className="hidden lg:block">
              <ManagerMessagingSetupBanner />
            </div>
            <main id={PORTAL_MAIN_CONTENT_ID} tabIndex={-1} className={PORTAL_MAIN_CONTENT_CLASS}>
              <PortalHorizontalScrollRoot>
                <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>
                  <PortalMobileNavBar
                    definition={nav.definition}
                    name={profile?.full_name ?? null}
                    email={profile?.email ?? null}
                    service={service?.shell}
                  />
                  {/* `empty:hidden`: a dismissed banner renders nothing, so its wrapper takes no flow slot. */}
                  <div className="lg:hidden empty:hidden">
                    <ManagerMessagingSetupBanner />
                  </div>
                  {children}
                </div>
              </PortalHorizontalScrollRoot>
            </main>
          </div>
          {/* The assistant's side panel (desktop). Renders nothing while closed,
              so the content column above keeps the full width. */}
          {viewAs ? null : (
            <PortalAssistantRail
              managerName={profile?.full_name ?? null}
              initialCollapsed={assistantDockCollapsed}
            />
          )}
        </div>
        </ServiceModeProvider>
        </PortalReadOnlyProvider>
        </WorkspaceProvider>
      </div>
    </AxisAssistant>
  );
}
