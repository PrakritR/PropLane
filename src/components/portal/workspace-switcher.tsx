"use client";

import Link from "next/link";
import { Building2, Check, ChevronsUpDown, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useWorkspaces } from "./workspace-provider";

export function WorkspaceSwitcher({ compact = false }: { compact?: boolean }) {
  const ctx = useWorkspaces();
  const { showToast } = useAppUi();
  if (!ctx) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="min-h-11 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-sm"
          aria-label={`Switch workspace: ${ctx.active?.name ?? "My workspace"}`} disabled={ctx.loading}
          data-attr="workspace-switcher">
          <Building2 className="size-5 shrink-0" aria-hidden />
          {!compact && <span className="min-w-0 flex-1 truncate text-left">{ctx.loading ? "Loading…" : ctx.active?.name ?? "My workspace"}</span>}
          {!compact && <ChevronsUpDown className="size-4 shrink-0" aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" backdrop>
        {ctx.workspaces.map((workspace) => <DropdownMenuItem key={workspace.id}
          onSelect={() => { void ctx.select(workspace.id).catch((e) => showToast(e.message)); }}>
          <span className="min-w-0 flex-1 truncate">{workspace.name}<span className="ml-2 text-xs text-muted">{workspace.owned ? "Owned" : "Shared"}</span></span>
          {workspace.id === ctx.active?.id && <Check className="size-4" aria-hidden />}
        </DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link href="/portal/profile?tab=workspaces"><Settings2 className="size-4" aria-hidden />Manage workspaces</Link></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
