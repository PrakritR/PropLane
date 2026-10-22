"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { AxisLogoGlyph } from "@/components/brand/axis-logo";
import { AdminNewServiceWorkspace } from "@/components/portal/admin-new-service-workspace";
import { workspaceTileLabels } from "@/components/portal/workspace-switcher";
import { useServiceWorkspaceOpen } from "@/components/portal/use-service-workspace-open";
import { serviceTileTitle, type ServiceShellData } from "@/lib/service/service-mode";
import { cn } from "@/lib/utils";

const TILE =
  "relative grid size-9 shrink-0 place-items-center rounded-[9px] text-[13px] font-bold outline-none transition-transform duration-100 focus-visible:ring-2 focus-visible:ring-white/70";
const RING = "shadow-[0_0_0_2px_#0c0d10,0_0_0_4px_#fff]";

/**
 * The rail in the admin portal and in service mode: the PropLane logo first (the software overview, admins only), then
 * one tile per PropLane Service workspace the viewer can open, then a + that creates another (admins only). A tile
 * runs the existing admin "open" (it sets the workspace cookie) and lands on that workspace's dashboard. Helpers see
 * only their own workspaces: no logo, no +.
 */
export function ServiceRailTiles({ service, onCreated: onCreatedProp }: { service: ServiceShellData; onCreated?: () => void }) {
  const { createOpen, setCreateOpen, busyId, open, onCreated } = useServiceWorkspaceOpen(service, onCreatedProp);
  const labels = workspaceTileLabels(service.workspaces.map((w) => w.name));
  const onAdminPage = service.activeId === null;

  return (
    <>
      {service.isAdmin ? (
        <>
          <Link
            href="/admin/dashboard"
            title="PropLane"
            aria-label="PropLane software overview"
            aria-current={onAdminPage ? "page" : undefined}
            data-attr="portal-rail-brand"
            className={cn(TILE, "bg-white hover:-translate-y-px", onAdminPage ? RING : "opacity-90")}
          >
            <AxisLogoGlyph size="micro" />
          </Link>
          {service.workspaces.length > 0 ? <span aria-hidden className="h-px w-6 shrink-0 bg-white/[0.18]" /> : null}
        </>
      ) : null}
      {service.workspaces.map((workspace, index) => {
        const active = workspace.id === service.activeId;
        return (
          <button
            key={workspace.id}
            type="button"
            title={serviceTileTitle(workspace)}
            aria-label={`Open ${serviceTileTitle(workspace)}`}
            aria-current={active ? "true" : undefined}
            data-attr="portal-rail-service-workspace"
            disabled={busyId !== null}
            onClick={() => {
              if (active) return;
              void open(workspace.id);
            }}
            className={cn(
              TILE,
              "hover:-translate-y-px disabled:opacity-60",
              active ? `bg-white text-[#0c0d10] ${RING}` : "bg-[#2b3448] text-white",
            )}
          >
            {labels[index]}
          </button>
        );
      })}
      {service.isAdmin ? (
        <>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            title="New PropLane Service workspace"
            aria-label="New PropLane Service workspace"
            data-attr="portal-rail-new-service-workspace"
            className={cn(TILE, "border border-dashed border-white/[0.28] text-inherit hover:bg-white/[0.08]")}
          >
            <Plus className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
          <AdminNewServiceWorkspace
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            onCreated={onCreated}
          />
        </>
      ) : null}
    </>
  );
}
