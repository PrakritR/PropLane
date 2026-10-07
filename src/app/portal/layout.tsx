import { RateAppPrompt } from "@/components/native/rate-app-prompt";
import { AccountLinksSync } from "@/components/portal/account-links-sync";
import { LandlordLegalNameCacheSync } from "@/components/portal/landlord-legal-name-cache-sync";
import { PropertyPipelineAccountSync } from "@/components/portal/property-pipeline-account-sync";
import { AxisAssistant } from "@/components/portal/axis-assistant";
import { PortalAssistantDockRail } from "@/components/portal/portal-assistant-dock-rail";
import { PortalDataPrefetch } from "@/components/portal/portal-data-prefetch";
import { ManagerMessagingSetupBanner } from "@/components/portal/messaging-setup-banner";
import { ManagerPlanBanner } from "@/components/portal/pro-plan-banner";
import { PortalMobileNavBar } from "@/components/portal/portal-mobile-nav-bar";
import { PortalSessionKeepalive } from "@/components/portal/portal-session-keepalive";
import { PortalClientSessionGuard } from "@/components/portal/portal-client-session-guard";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { PortalHorizontalScrollRoot } from "@/components/portal/portal-horizontal-scroll";
import { PortalSkipLink } from "@/components/portal/portal-skip-link";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { PortalWorkspaceRail } from "@/components/portal/portal-workspace-rail";
import { SurfaceThemeDefault } from "@/components/providers/theme-provider";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { OwnerPortalShell } from "@/components/owner/owner-portal-shell";
import { getOwnerAccessState, type OwnerAccessState } from "@/lib/property-owner/access.server";
import { PortalAccessUnavailable } from "@/components/portal/portal-access-unavailable";
import { OWNER_HOME_PATH, ownerRedirectFor } from "@/lib/property-owner/sections";
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
import { TestAccountBanner } from "@/components/portal/test-account-banner";
import { TestAccountUnavailable } from "@/components/portal/test-account-unavailable";
import { isTestWorkspaceFeatureEnabled, resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

export default async function PropertyPortalLayout({ children }: { children: React.ReactNode }) {
  // A production admin (founder/ops) identity must not cross into the property
  // portal even by typing the URL — hiding the switch is not access control.
  await assertPropertyPortalAccess();

  // An owner-only account (a Property owner with no houses, plan or team seat
  // of their own) gets the owner shell and nothing else under /portal. Any
  // other path, typed or followed from an old link, lands on their Overview.
  // The menu is not the boundary (the manager APIs refuse them on the server);
  // this is the page half of the same rule.
  // The two cookie reads need no identity, so they ride along with the session
  // lookup instead of waiting behind the owner and nav lookups below.
  const [session, sidebarCollapsed, assistantDockCollapsed] = await Promise.all([
    getServerSessionProfile(),
    getSidebarCollapsed(),
    getAssistantDockCollapsed(),
  ]);
  if (session.user) {
    let owner: OwnerAccessState;
    try {
      owner = await getOwnerAccessState(session.user.id);
    } catch {
      return <PortalAccessUnavailable />;
    }
    if (owner.ownerOnly) {
      const pathname = (await headers()).get("x-pathname") ?? "";
      // No path to judge means we cannot say this page is one of theirs, so the
      // requested manager page must not render inside the owner chrome: send
      // them to their Overview instead (middleware stamps the header on every
      // matched request, so this is the never-happens branch failing closed).
      const target = pathname ? ownerRedirectFor(pathname, owner.messagesOn) : OWNER_HOME_PATH;
      if (target) redirect(target);
      return <OwnerPortalShell messagesOn={owner.messagesOn}>{children}</OwnerPortalShell>;
    }
  }

  // Past the owner gate: the nav definition and the test-workspace
  // classification are independent of each other, so they resolve together.
  // `session` is already resolved (and request-cached), so `user` is known.
  const { profile, user } = session;
  const [nav, testWorkspace] = await Promise.all([
    buildProPortalDefinition(),
    user ? resolveTestWorkspaceClassification(user.id) : Promise.resolve({ kind: "normal" as const }),
  ]);
  if (testWorkspace.kind === "classified" && (testWorkspace.state !== "active" || !isTestWorkspaceFeatureEnabled())) {
    return <TestAccountUnavailable state={testWorkspace.state} />;
  }

  return (
    <AxisAssistant managerName={profile?.full_name ?? null} smsTestPortal="manager" dockable>
      <div className={PORTAL_SHELL_ROOT_CLASS}>
        <WorkspaceProvider>
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
        />
        <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
          <PortalSkipLink />
          <PortalWorkspaceRail
            kind={nav.definition.kind}
            basePath={nav.definition.basePath}
            name={profile?.full_name ?? null}
            email={profile?.email ?? null}
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
                  />
                  <div className="lg:hidden">
                    <ManagerMessagingSetupBanner />
                  </div>
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
        </WorkspaceProvider>
      </div>
    </AxisAssistant>
  );
}
