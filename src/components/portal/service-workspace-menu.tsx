"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
import Link from "next/link";
import { AxisLogoGlyph } from "@/components/brand/axis-logo";
import { AdminNewServiceWorkspace } from "@/components/portal/admin-new-service-workspace";
import { useServiceWorkspaceOpen } from "@/components/portal/use-service-workspace-open";
import { workspaceTileLabels } from "@/components/portal/workspace-switcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { serviceTileTitle, type ServiceShellData } from "@/lib/service/service-mode";

/**
 * The phone's way to switch workspaces in the admin portal and in service mode (the desktop rail is hidden below lg):
 * the top bar's left slot, in the manager `WorkspaceSwitcher` mobile look - tile, current name, chevron. Rows: PropLane
 * (admins; the software overview), each service workspace the viewer can open (city as a plain fact), then New
 * workspace (admins). An open is the rail's own `open`; the server authorizes every one.
 */
export function ServiceWorkspaceMenu({ service }: { service: ServiceShellData }) {
  const { createOpen, setCreateOpen, busyId, open, onCreated } = useServiceWorkspaceOpen(service);
  const labels = workspaceTileLabels(service.workspaces.map((w) => w.name));
  const activeIndex = service.workspaces.findIndex((w) => w.id === service.activeId);
  const active = activeIndex >= 0 ? service.workspaces[activeIndex]! : null;
  const onAdminPage = active === null;
  const name = active ? serviceTileTitle(active) : "PropLane";

  const tile = onAdminPage ? (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-white shadow-[inset_0_0_0_1px_var(--border)]" aria-hidden>
      <AxisLogoGlyph size="micro" />
    </span>
  ) : (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[#2b3448] text-[12px] font-bold text-white"
      aria-hidden
    >
      {labels[activeIndex]}
    </span>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-lg px-1 text-left text-base font-semibold tracking-[-0.02em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            aria-label={`Switch workspace: ${name}`}
            data-attr="service-workspace-menu"
          >
            {tile}
            <span className="min-w-0 truncate">{name}</span>
            <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-max min-w-[220px] max-w-[320px]">
          {service.isAdmin ? (
            <DropdownMenuItem asChild>
              <Link href="/admin/dashboard" data-attr="service-workspace-menu-item" aria-current={onAdminPage ? "page" : undefined}>
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/10" aria-hidden>
                  <AxisLogoGlyph size="micro" />
                </span>
                <span className="min-w-0 flex-1 truncate">PropLane</span>
                {onAdminPage ? <Check className="size-4 shrink-0" aria-hidden /> : null}
              </Link>
            </DropdownMenuItem>
          ) : null}
          {service.workspaces.map((workspace, index) => {
            const isActive = workspace.id === service.activeId;
            return (
              <DropdownMenuItem
                key={workspace.id}
                disabled={busyId !== null}
                aria-current={isActive ? "true" : undefined}
                data-attr="service-workspace-menu-item"
                onSelect={() => {
                  if (isActive) return;
                  void open(workspace.id);
                }}
              >
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[#2b3448] text-[10px] font-bold text-white"
                  aria-hidden
                >
                  {labels[index]}
                </span>
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {workspace.city ? <span className="shrink-0 text-xs text-muted">{workspace.city}</span> : null}
                {isActive ? <Check className="size-4 shrink-0" aria-hidden /> : null}
              </DropdownMenuItem>
            );
          })}
          {service.isAdmin ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-attr="service-workspace-menu-new" onSelect={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden />
                <span className="min-w-0 flex-1">New workspace</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {service.isAdmin ? (
        <AdminNewServiceWorkspace open={createOpen} onClose={() => setCreateOpen(false)} onCreated={onCreated} />
      ) : null}
    </>
  );
}
