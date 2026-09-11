"use client";

import Link from "next/link";
import { Building2, Check, ChevronDown, Settings2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "./workspace-provider";

/**
 * Top-left workspace control. The sidebar variant is a soft card (name +
 * "Owner · Switch workspace"); the mobile variant is the page's own header
 * line (name + chevron) since the phone top bar has no room for a card.
 */
export function WorkspaceSwitcher({
  compact = false,
  variant = "sidebar",
}: {
  compact?: boolean;
  variant?: "sidebar" | "mobile";
}) {
  const ctx = useWorkspaces();
  const { showToast } = useAppUi();
  if (!ctx) return null;
  const name = ctx.loading ? "Loading…" : (ctx.active?.name ?? "My workspace");
  const role = ctx.active ? (ctx.active.owned ? "Owner" : "Shared access") : "";

  const trigger =
    variant === "mobile" ? (
      <button
        type="button"
        className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1 rounded-lg px-1 text-left text-lg font-semibold tracking-[-0.02em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        aria-label={`Switch workspace: ${name}`}
        disabled={ctx.loading}
        data-attr="workspace-switcher"
      >
        <span className="min-w-0 truncate">{name}</span>
        <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
      </button>
    ) : compact ? (
      <button
        type="button"
        className="grid h-10 w-10 place-items-center rounded-lg text-muted outline-none transition hover:bg-[var(--secondary)]/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/30"
        aria-label={`Switch workspace: ${name}`}
        title={name}
        disabled={ctx.loading}
        data-attr="workspace-switcher"
      >
        <Building2 className="size-5" aria-hidden />
      </button>
    ) : (
      <button
        type="button"
        className={cn(
          "flex min-h-12 w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-[var(--secondary)]/60 px-3 py-2 text-left outline-none transition",
          "hover:border-primary/30 hover:bg-[var(--secondary)] focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-70",
        )}
        aria-label={`Switch workspace: ${name}`}
        disabled={ctx.loading}
        data-attr="workspace-switcher"
      >
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-semibold text-foreground">{name}</span>
          <span className="block truncate text-[11px] text-muted">
            {role ? `${role} · Switch workspace` : "Switch workspace"}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
      </button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" backdrop>
        {ctx.workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => {
              void ctx.select(workspace.id).catch((e) => showToast(e.message));
            }}
          >
            <span className="min-w-0 flex-1 truncate">
              {workspace.name}
              <span className="ml-2 text-xs text-muted">{workspace.owned ? "Owned" : "Shared"}</span>
            </span>
            {workspace.id === ctx.active?.id && <Check className="size-4" aria-hidden />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/portal/profile?tab=workspaces">
            <Settings2 className="size-4" aria-hidden />
            Manage workspaces
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
