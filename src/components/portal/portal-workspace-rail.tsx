"use client";

import { HelpCircle, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AxisLogoGlyph } from "@/components/brand/axis-logo";
import { PortalAccountMenu } from "@/components/portal/portal-account-menu";
import { PortalHelpPanel } from "@/components/portal/portal-help-panel";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { usePortalSession } from "@/hooks/use-portal-session";
import type { PortalKind } from "@/lib/portal-types";
import type { PortalWorkspace } from "@/lib/workspaces/types";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "./workspace-provider";
import { workspaceInitials } from "./workspace-switcher";

/** Same disambiguation the switcher menu uses: a shared workspace names its owner. */
function tileTitle(workspace: PortalWorkspace): string {
  if (workspace.owned || !workspace.ownerName) return workspace.name;
  return `${workspace.name} (${workspace.ownerName})`;
}

const TILE =
  "relative grid size-9 shrink-0 place-items-center rounded-[9px] text-[13px] font-bold outline-none transition-transform duration-100 focus-visible:ring-2 focus-visible:ring-white/70";

/**
 * The 60px workspace rail (desktop, `lg+`), the dark column under the top strip.
 *
 * Manager: one rounded tile per workspace, from the SAME context the workspace
 * switcher menu reads. The active tile is white with a ring; clicking another
 * runs the existing switch (`select`), which re-points every count and the
 * Conversations list at that workspace. The dashed + is the existing "New
 * workspace" entry. Resident / vendor / admin: one non-interactive brand tile.
 *
 * Bottom: Help (opens the existing help + feedback panel, formerly the sidebar
 * footer) and the avatar (the existing account menu, formerly the top bar).
 */
export function PortalWorkspaceRail({
  kind,
  basePath,
  name,
  email,
}: {
  kind: PortalKind;
  basePath: string;
  name: string | null;
  email: string | null;
}) {
  const ctx = useWorkspaces();
  const pathname = usePathname();
  const { showToast } = useAppUi();
  const session = usePortalSession();
  const [helpOpen, setHelpOpen] = useState(false);
  const isWorkspacePortal = kind === "manager" || kind === "pro";
  // Settings follows the workspace picked here, so switching while in Settings stays in Settings.
  const inSettings = /\/profile(\/|$)/.test(pathname ?? "");

  const workspaceTiles = (() => {
    if (!isWorkspacePortal || !ctx) return null;
    if (ctx.loading && ctx.workspaces.length === 0) {
      return <span className={cn(TILE, "animate-pulse bg-[#2b3448] motion-reduce:animate-none")} aria-hidden />;
    }
    if (ctx.workspaces.length === 0) {
      // A brand-new account has no persisted workspace yet: still name the one it is standing in.
      const fallback = ctx.active?.name ?? "My workspace";
      return (
        <span
          className={cn(TILE, "bg-white text-[#101828] shadow-[0_0_0_2px_#101828,0_0_0_4px_#fff]")}
          title={fallback}
          aria-label={fallback}
          data-attr="portal-rail-workspace"
          aria-current="true"
        >
          {workspaceInitials(fallback)}
        </span>
      );
    }
    return ctx.workspaces.map((workspace) => {
      const active = workspace.id === ctx.active?.id;
      const title = tileTitle(workspace);
      return (
        <button
          key={workspace.id}
          type="button"
          title={title}
          aria-label={`Switch workspace: ${title}`}
          aria-current={active ? "true" : undefined}
          data-attr="portal-rail-workspace"
          onClick={() => {
            if (active) return;
            void ctx.select(workspace.id, inSettings ? { href: false } : undefined).catch((e: Error) => showToast(e.message));
          }}
          className={cn(
            TILE,
            "hover:-translate-y-px",
            active
              ? "bg-white text-[#101828] shadow-[0_0_0_2px_#101828,0_0_0_4px_#fff]"
              : "bg-[#2b3448] text-white",
          )}
        >
          {workspaceInitials(workspace.name)}
        </button>
      );
    });
  })();

  return (
    <>
      <nav
        aria-label="Workspaces"
        data-slot="portal-workspace-rail"
        className="hidden w-[60px] shrink-0 flex-col items-center gap-2.5 bg-[var(--portal-strip-bg,#101828)] py-2.5 text-[var(--portal-strip-fg,#c7ccd6)] lg:flex"
      >
        {isWorkspacePortal ? (
          <>
            {workspaceTiles}
            <Link
              href="/portal/profile?tab=workspaces&new=1"
              title="New workspace"
              aria-label="New workspace"
              data-attr="portal-rail-new-workspace"
              className={cn(
                TILE,
                "border border-dashed border-white/[0.28] text-inherit hover:bg-white/[0.08]",
              )}
            >
              <Plus className="size-4" strokeWidth={1.75} aria-hidden />
            </Link>
          </>
        ) : (
          <span
            className={cn(TILE, "bg-white shadow-[0_0_0_2px_#101828,0_0_0_4px_#fff]")}
            title="PropLane"
            data-attr="portal-rail-brand"
          >
            <AxisLogoGlyph size="micro" />
          </span>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          title="Help and feedback"
          aria-label="Help and feedback"
          data-attr="portal-sidebar-help"
          className="grid size-9 place-items-center rounded-[9px] text-inherit outline-none transition hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <HelpCircle className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </button>

        <PortalAccountMenu
          kind={kind}
          basePath={basePath}
          name={name}
          email={email}
          onOpenHelp={() => setHelpOpen(true)}
        />
      </nav>

      <PortalHelpPanel
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        reporterRole={kind}
        reporterUserId={session.userId}
        reporterEmail={session.email ?? ""}
        reporterName={session.email ?? ""}
      />
    </>
  );
}
