import { headers } from "next/headers";
import { Suspense } from "react";
import { AxisAssistant } from "@/components/portal/axis-assistant";
import { PortalDataPrefetch } from "@/components/portal/portal-data-prefetch";
import { PortalMobileNavBar } from "@/components/portal/portal-mobile-nav-bar";
import { RateAppPrompt } from "@/components/native/rate-app-prompt";
import { PortalSessionKeepalive } from "@/components/portal/portal-session-keepalive";
import { PortalClientSessionGuard } from "@/components/portal/portal-client-session-guard";
import { ResidentPreApplicationGuard } from "@/components/portal/resident-pre-application-guard";
import { ResidentTourLinkOnMount } from "@/components/portal/resident-tour-link-on-mount";
import { ResidentProspectHandoffOnMount } from "@/components/portal/resident-prospect-handoff-on-mount";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { PortalSkipLink } from "@/components/portal/portal-skip-link";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { PortalWorkspaceRail } from "@/components/portal/portal-workspace-rail";
import { SurfaceThemeDefault } from "@/components/providers/theme-provider";
import {
  PORTAL_MAIN_CONTENT_CLASS,
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MAIN_CONTENT_INNER_CLASS,
  PORTAL_SHELL_ROOT_CLASS,
} from "@/lib/portal-layout-classes";
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { assertPortalLayoutRole } from "@/lib/auth/portal-layout-guard";
import { getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";
import { loadResidentPortalAccessState } from "@/lib/resident-portal-access";
import { resolveResidentPortalNavStage } from "@/lib/resident-portal-nav";
import { getResidentPortalDefinition } from "@/lib/portals/resident";
import { getSidebarCollapsed } from "@/lib/portal-sidebar-state";
import { TestAccountBanner } from "@/components/portal/test-account-banner";
import { TestAccountUnavailable } from "@/components/portal/test-account-unavailable";
import { isTestWorkspaceFeatureEnabled, resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";
import { ViewAsBanner } from "@/components/portal/view-as-banner";
import { getViewAsBannerState } from "@/lib/auth/view-as-banner.server";

function isResidentApplicationsApplyPath(pathname: string): boolean {
  return pathname === "/resident/applications/apply";
}

function isResidentTourPath(pathname: string): boolean {
  return pathname === "/resident/tour" || pathname.startsWith("/resident/tour/");
}

export default async function ResidentLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get("x-pathname") ?? "";
  await assertPortalLayoutRole("resident", "resident", {
    allowSignedInApplyGate: isResidentApplicationsApplyPath(pathname),
    allowResidentTourAccess: isResidentTourPath(pathname),
  });

  const residentPortal = await getResidentPortalDefinition();
  const { profile, user } = await getEffectiveSessionForPortal("resident");
  const managerSubscriptionTier = profile?.manager_id?.trim()
    ? await getManagerSubscriptionTierByManagerId(profile.manager_id.trim())
    : null;
  const access = await loadResidentPortalAccessState({
    userId: user?.id ?? null,
    role: profile?.role,
    email: profile?.email ?? user?.email ?? null,
    managerSubscriptionTier,
  });
  const sidebarCollapsed = await getSidebarCollapsed();

  const residentNavStage = resolveResidentPortalNavStage(access);
  const testWorkspace = user ? await resolveTestWorkspaceClassification(user.id) : { kind: "normal" as const };
  if (testWorkspace.kind === "classified" && (testWorkspace.state !== "active" || !isTestWorkspaceFeatureEnabled())) {
    return <TestAccountUnavailable state={testWorkspace.state} />;
  }

  // A "View as" support session: banner on top, assistant off.
  const viewAs = await getViewAsBannerState();

  return (
    // The resident assistant must carry its own role-scoped endpoint: the default manager endpoint
    // 401s for residents (captain, Oct 7: residents get Ask PropLane like vendors).
    <AxisAssistant endpoint="/api/agent/resident-chat" managerName={profile?.full_name ?? null} disabled={Boolean(viewAs)}>
    <div className={PORTAL_SHELL_ROOT_CLASS}>
      {viewAs ? <ViewAsBanner {...viewAs} /> : null}
      <SurfaceThemeDefault theme="light" />
      <PortalDataPrefetch kind="resident" />
      <PortalSessionKeepalive />
      <PortalClientSessionGuard />
      <RateAppPrompt reporterRole="resident" />
      <PortalTopBar
        kind={residentPortal.kind}
        basePath={residentPortal.basePath}
        definition={residentPortal}
        subscriptionTier={managerSubscriptionTier}
        residentNavStage={residentNavStage}
        initialSidebarCollapsed={sidebarCollapsed}
        name={profile?.full_name ?? null}
        email={profile?.email ?? null}
      />
      <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
        <PortalSkipLink />
        <PortalWorkspaceRail
          kind={residentPortal.kind}
          basePath={residentPortal.basePath}
          name={profile?.full_name ?? null}
          email={profile?.email ?? null}
        />
        <PortalSidebar
          definition={residentPortal}
          subscriptionTier={managerSubscriptionTier}
          subtitle="Resident"
          initialCollapsed={sidebarCollapsed}
          residentNavStage={residentNavStage}
        />
        <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {testWorkspace.kind === "classified" ? <TestAccountBanner state={testWorkspace.state} /> : null}
          <main id={PORTAL_MAIN_CONTENT_ID} tabIndex={-1} className={PORTAL_MAIN_CONTENT_CLASS}>
            <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>
              <PortalMobileNavBar
                definition={residentPortal}
                name={profile?.full_name ?? null}
                email={profile?.email ?? null}
              />
              <Suspense fallback={null}>
                <ResidentTourLinkOnMount />
                <ResidentProspectHandoffOnMount />
              </Suspense>
              <ResidentPreApplicationGuard access={access}>
                {children}
              </ResidentPreApplicationGuard>
            </div>
          </main>
        </div>
      </div>
    </div>
    </AxisAssistant>
  );
}
