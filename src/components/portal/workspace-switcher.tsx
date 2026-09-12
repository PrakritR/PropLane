"use client";

import Link from "next/link";
import { Building2, Check, ChevronDown, Plus, Settings2, UserPlus } from "lucide-react";
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

/** "Ash Flats" → "AF"; "My workspace" → "MW"; one word → its first two letters. */
export function workspaceInitials(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "W";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * Top-left workspace control.
 *
 * The `header` variant is the sidebar's first block, the way Linear and Loom
 * open with the workspace itself — avatar, name, "Owner · 3 properties",
 * chevron — rather than a product logo above a separate "My workspace" box.
 * The `mobile` variant is the page's own header line (name + chevron), since
 * the phone top bar has no room for a card.
 *
 * The menu, top to bottom: the workspaces this account can enter (current one
 * checked), then Workspace settings, Invite a manager, and New workspace with
 * the plan cap shown inline ("2 of 3") so the limit is visible before the
 * click, not after it.
 */
export function WorkspaceSwitcher({
  compact = false,
  variant = "header",
}: {
  compact?: boolean;
  variant?: "header" | "mobile";
}) {
  const ctx = useWorkspaces();
  const { showToast } = useAppUi();
  if (!ctx) return null;
  const name = ctx.loading ? "Loading…" : (ctx.active?.name ?? "My workspace");
  const role = ctx.active ? (ctx.active.owned ? "Owner" : "Shared access") : "";
  const propertyCount = ctx.active?.propertyIds.length ?? 0;
  const meta = [role, ctx.active ? `${propertyCount} ${propertyCount === 1 ? "property" : "properties"}` : ""]
    .filter(Boolean)
    .join(" · ");
  const plan = ctx.plan;
  const capKnown = Boolean(plan && !plan.unknown);
  const atCap = capKnown ? plan!.usage.workspaces >= plan!.workspaceLimit : false;
  const capLabel = capKnown ? `${plan!.usage.workspaces} of ${plan!.workspaceLimit}` : "";

  const avatar = (
    <span
      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-[11px] font-bold tracking-tight text-primary"
      aria-hidden
    >
      {ctx.loading ? <Building2 className="size-4" /> : workspaceInitials(name)}
    </span>
  );

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
        className="grid h-10 w-10 place-items-center rounded-lg outline-none transition hover:bg-[var(--secondary)]/60 focus-visible:ring-2 focus-visible:ring-primary/30"
        aria-label={`Switch workspace: ${name}`}
        title={name}
        disabled={ctx.loading}
        data-attr="workspace-switcher"
      >
        {avatar}
      </button>
    ) : (
      <button
        type="button"
        className={cn(
          "flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left outline-none transition",
          "hover:bg-[var(--secondary)]/70 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-70",
        )}
        aria-label={`Switch workspace: ${name}`}
        disabled={ctx.loading}
        data-attr="workspace-switcher"
      >
        {avatar}
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">{name}</span>
          {meta ? <span className="block truncate text-[10.5px] text-muted">{meta}</span> : null}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
      </button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" backdrop className="min-w-[240px]">
        {ctx.workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => {
              void ctx.select(workspace.id).catch((e) => showToast(e.message));
            }}
            data-attr="workspace-switcher-item"
          >
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/10 text-[10px] font-bold text-primary"
              aria-hidden
            >
              {workspaceInitials(workspace.name)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {workspace.name}
              <span className="ml-2 text-xs text-muted">{workspace.owned ? "Owned" : "Shared"}</span>
            </span>
            {workspace.id === ctx.active?.id && <Check className="size-4" aria-hidden />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/portal/profile?tab=workspaces" data-attr="workspace-switcher-settings">
            <Settings2 className="size-4" aria-hidden />
            Workspace settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/portal/profile?tab=team" data-attr="workspace-switcher-invite">
            <UserPlus className="size-4" aria-hidden />
            Invite a manager
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            href="/portal/profile?tab=workspaces&new=1"
            data-attr="workspace-switcher-new"
            aria-disabled={atCap ? true : undefined}
            className={cn(atCap && "text-muted")}
          >
            <Plus className="size-4" aria-hidden />
            <span className="min-w-0 flex-1">New workspace</span>
            {capLabel ? <span className="text-xs tabular-nums text-muted">{capLabel}</span> : null}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
