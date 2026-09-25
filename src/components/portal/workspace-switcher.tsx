"use client";

import { TEAM_ROLE_LABELS } from "@/lib/co-manager-team-roles";
import type { PortalWorkspace } from "@/lib/workspaces/types";

import Link from "next/link";
import { Check, ChevronDown, Plus, Settings, UserPlus } from "lucide-react";
import { AxisLogoGlyph } from "@/components/brand/axis-logo";
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
/**
 * "Owner · 10 houses", "Admin · All houses", "Viewer · 3 houses" — the standing
 * the viewer has in a workspace, in one line. A shared workspace only lists the
 * houses the viewer reaches, so a selected scope prints that count.
 */
function standingLabel(workspace: PortalWorkspace): string {
  // Live houses only — a workspace's record list also holds drafts and
  // unlisted rows that still drive scoping (PRP-481).
  const count = workspace.livePropertyCount ?? 0;
  const houses = `${count} ${count === 1 ? "house" : "houses"}`;
  if (workspace.owned) return `Owner · ${houses}`;
  const role = workspace.viewerRole && workspace.viewerRole !== "owner" ? TEAM_ROLE_LABELS[workspace.viewerRole] : "Shared";
  if (workspace.viewerHouseScope === "all") return `${role} · All houses`;
  return `${role} · ${houses}`;
}

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
  const meta = ctx.active ? standingLabel(ctx.active) : "";
  const plan = ctx.plan;
  const capKnown = Boolean(plan && !plan.unknown);
  const atCap = capKnown ? plan!.usage.workspaces >= plan!.workspaceLimit : false;
  const capLabel = capKnown ? `${plan!.usage.workspaces} of ${plan!.workspaceLimit}` : "";

  // Every workspace shows the same PropLane house mark rather than its own
  // initials tile — one brand glyph everywhere, not a per-workspace "SH"/"AF"
  // (spec:addendum-1, C007). The name still distinguishes workspaces in the
  // label beside it and in the switcher menu below.
  const avatar = (
    <span
      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10"
      aria-hidden
    >
      <AxisLogoGlyph size="micro" />
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
        {ctx.loading ? (
          <span
            className="inline-block h-[1.1em] w-28 animate-pulse rounded-full bg-accent/60 motion-reduce:animate-none"
            aria-hidden
          />
        ) : (
          <span className="min-w-0 truncate">{name}</span>
        )}
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
          {ctx.loading ? (
            <span
              className="block h-[0.9em] w-20 animate-pulse rounded-full bg-accent/60 motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <span className="block truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">{name}</span>
          )}
          {meta ? <span className="block truncate text-[10.5px] text-muted">{meta}</span> : null}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
      </button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        {ctx.workspaces.length === 0 && !ctx.loading ? (
          // A brand-new account has no persisted workspace yet; the menu still
          // names the one it is standing in rather than opening on a separator.
          <DropdownMenuItem disabled data-attr="workspace-switcher-item">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/10" aria-hidden>
              <AxisLogoGlyph size="micro" />
            </span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <Check className="size-4" aria-hidden />
          </DropdownMenuItem>
        ) : null}
        {ctx.workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => {
              void ctx.select(workspace.id).catch((e) => showToast(e.message));
            }}
            data-attr="workspace-switcher-item"
          >
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/10"
              aria-hidden
            >
              <AxisLogoGlyph size="micro" />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {workspace.name}
              {/* The home count is what tells a manager WHERE their portfolio
                  is: a workspace showing nothing is answered by the row that
                  holds the homes, without opening settings first. */}
              <span className="ml-2 text-xs text-muted">{standingLabel(workspace)}</span>
            </span>
            {workspace.id === ctx.active?.id && <Check className="size-4" aria-hidden />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/portal/profile?tab=workspaces" data-attr="workspace-switcher-settings">
            <Settings className="size-4" aria-hidden />
            Workspace settings
          </Link>
        </DropdownMenuItem>
        {ctx.active?.owned || ctx.active?.canManageMembers ? (
          <DropdownMenuItem asChild>
            {/* Invite lives on each workspace card; land on the active one. */}
            <Link href={`/portal/profile?tab=workspaces${ctx.active ? `#workspace-${ctx.active.id}` : ""}`} data-attr="workspace-switcher-invite">
              <UserPlus className="size-4" aria-hidden />
              <span className="min-w-0 truncate">Invite a manager to {ctx.active.name}</span>
            </Link>
          </DropdownMenuItem>
        ) : null}
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
