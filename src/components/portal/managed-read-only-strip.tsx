"use client";

import Link from "next/link";
import { usePortalReadOnly } from "@/components/portal/portal-read-only-context";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { Button } from "@/components/ui/button";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import { workspaceTeamThreadId } from "@/lib/team-thread-id";

/**
 * The one strip under the top bar on every Property-portal page while the active workspace is view-only: PropLane
 * manages the workspace for its owner (the `data-read-only="managed"` stamp comes from PortalReadOnlyProvider). Renders
 * nothing for everyone else.
 *
 * "Message the team" opens Communication on the workspace Team chat; "Get a plan" opens Settings › Billing & plan.
 */
export function ManagedReadOnlyStrip() {
  const readOnly = usePortalReadOnly();
  const active = useWorkspaces()?.active ?? null;
  return (
    <>
      {readOnly && active ? (
        <div
          role="region"
          aria-label="View only"
          data-attr="managed-read-only-strip"
          className="flex w-full shrink-0 items-center justify-between gap-3 border-b border-border bg-accent/50 px-4 py-2 max-lg:flex-wrap"
        >
          <p className="min-w-0 truncate text-[13px] font-medium text-foreground">Managed by PropLane · View only</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild variant="outline" data-attr="managed-read-only-message-team">
              <Link href={`/portal/communication/active/${encodeURIComponent(workspaceTeamThreadId(active.ownerUserId, active.id))}`}>
                Message the team
              </Link>
            </Button>
            <Button asChild data-attr="managed-read-only-get-plan">
              <Link href={MANAGER_PLAN_PORTAL_URL}>Get a plan</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
