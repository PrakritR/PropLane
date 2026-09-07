import { AxisAssistant } from "@/components/portal/axis-assistant";
import { PortalAssistantRail } from "@/components/portal/portal-assistant-rail";
import { PortalClientSessionGuard } from "@/components/portal/portal-client-session-guard";
import { PortalMobileNavBar } from "@/components/portal/portal-mobile-nav-bar";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { PortalSkipLink } from "@/components/portal/portal-skip-link";
import { PortalTopBar } from "@/components/portal/portal-top-bar";
import { PublicHomePrefetch } from "@/components/layout/public-home-prefetch";
import { SurfaceThemeDefault } from "@/components/providers/theme-provider";
import { assertAdminPortalAccess } from "@/lib/auth/portal-access";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import {
  PORTAL_MAIN_CONTENT_CLASS,
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MAIN_CONTENT_INNER_CLASS,
  PORTAL_SHELL_ROOT_CLASS,
} from "@/lib/portal-layout-classes";
import { adminPortal } from "@/lib/portals/admin";
import { getSidebarCollapsed } from "@/lib/portal-sidebar-state";
import { getAssistantDockCollapsed, getAssistantDocked } from "@/lib/assistant-dock-state";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await assertAdminPortalAccess();
  const { profile } = await getServerSessionProfile();
  const [sidebarCollapsed, assistantDockCollapsed, assistantDocked] = await Promise.all([
    getSidebarCollapsed(),
    getAssistantDockCollapsed(),
    getAssistantDocked(),
  ]);
  return (
    <AxisAssistant managerName={profile?.full_name ?? null}>
      <div className={PORTAL_SHELL_ROOT_CLASS} data-surface="admin">
        <SurfaceThemeDefault theme="dark" />
        <PublicHomePrefetch />
        <PortalClientSessionGuard />
        <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
          <PortalSkipLink />
          <PortalSidebar definition={adminPortal} subtitle="Admin" initialCollapsed={sidebarCollapsed} />
          <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <PortalTopBar
              kind={adminPortal.kind}
              basePath={adminPortal.basePath}
              name={profile?.full_name ?? null}
              email={profile?.email ?? null}
            />
            <main id={PORTAL_MAIN_CONTENT_ID} tabIndex={-1} className={PORTAL_MAIN_CONTENT_CLASS}>
              <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>
                <PortalMobileNavBar
                  definition={adminPortal}
                  name={profile?.full_name ?? null}
                  email={profile?.email ?? null}
                />
                {children}
              </div>
            </main>
          </div>
          <PortalAssistantRail
            managerName={profile?.full_name ?? null}
            initialCollapsed={assistantDockCollapsed}
            initialDocked={assistantDocked}
          />
        </div>
      </div>
    </AxisAssistant>
  );
}
