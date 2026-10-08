import React from "react";
import { createRoot } from "react-dom/client";
import { AppUiProvider } from "../../../src/components/providers/app-ui-provider";
import { PortalTopBar } from "../../../src/components/portal/portal-top-bar";
import { PortalSidebar } from "../../../src/components/portal/portal-sidebar";
import { ManagerLeases } from "../../../src/components/portal/pro-leases";
import { PortalCalendar } from "../../../src/components/portal/portal-calendar";
import { ViewAsBanner } from "../../../src/components/portal/view-as-banner";
import { AxisAssistant } from "../../../src/components/portal/axis-assistant";
import { LifecycleFrame } from "../../../src/components/marketing/site/lifecycle-frame";
import { AdminViewAsAction } from "../../../src/components/portal/admin-view-as-action";
import { proPortal } from "../../../src/lib/portals/pro";
import {
  PORTAL_MAIN_CONTENT_CLASS,
  PORTAL_MAIN_CONTENT_ID,
  PORTAL_MAIN_CONTENT_INNER_CLASS,
  PORTAL_SHELL_ROOT_CLASS,
} from "../../../src/lib/portal-layout-classes";

const surface = new URLSearchParams(location.search).get("surface") ?? "shell";

/**
 * The real portal chrome, assembled exactly as the authenticated layout does it:
 * dark top strip (Ask PropLane + ⌘K), the workspace rail, and the page column with
 * the shared main-content classes (so a page's own bands land where they really do).
 */
function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <div className={PORTAL_SHELL_ROOT_CLASS}>
      <PortalTopBar kind="manager" basePath="/portal" definition={proPortal} subscriptionTier="paid" />
      <div className="flex min-h-0 flex-1">
        <PortalSidebar definition={proPortal} subscriptionTier="paid" subtitle="Pro" />
        <main id={PORTAL_MAIN_CONTENT_ID} className={PORTAL_MAIN_CONTENT_CLASS}>
          <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>{children}</div>
        </main>
      </div>
      <AxisAssistant managerName="Avery Stone" />
    </div>
  );
}

function Surface() {
  if (surface === "shell" || surface === "palette") return <Shell />;
  if (surface === "leases")
    return (
      <Shell>
        <ManagerLeases tab="draft" basePath="/portal" />
      </Shell>
    );
  if (surface === "calendar")
    return (
      <Shell>
        <PortalCalendar portal="manager" initialUserId="mgr-1" initialEmail="manager@example.com" />
      </Shell>
    );
  if (surface === "view-as")
    return (
      <div>
        <ViewAsBanner
          name="Mia Manager"
          portal="manager"
          expiresAtMs={Date.now() + 29 * 60_000 + 40_000}
          endHref="/admin/axis-users/manager-abc"
        />
        <Shell />
      </div>
    );
  // b7b's empty View-as slot now delegates to b7a's dialog — and stays hidden for a disabled account.
  if (surface === "view-as-action")
    return (
      <div style={{ padding: 32, display: "flex", gap: 48, alignItems: "center" }}>
        <div data-case="active" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ font: "500 14px system-ui" }}>Active account</span>
          <AdminViewAsAction
            account={{ id: "mgr-abc", kind: "manager", email: "mia@example.com", name: "Mia Manager", active: true }}
          />
        </div>
        <div data-case="disabled" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ font: "500 14px system-ui" }}>Disabled account</span>
          <AdminViewAsAction
            account={{ id: "mgr-off", kind: "manager", email: "off@example.com", name: "Dana Disabled", active: false }}
          />
        </div>
      </div>
    );
  if (surface.startsWith("home-")) {
    const [, portal, tab] = surface.split("-");
    return (
      <div style={{ padding: 24, background: "#fff" }}>
        <LifecycleFrame
          portal={portal as "manager" | "resident" | "vendor"}
          tab={tab ?? "dashboard"}
          label={tab ?? "Dashboard"}
        />
      </div>
    );
  }
  return <Shell />;
}

createRoot(document.getElementById("root")!).render(
  <AppUiProvider>
    <Surface />
  </AppUiProvider>,
);
