"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOwnerWorkspace } from "@/components/owner/owner-workspace";
import { cn } from "@/lib/utils";

/** "1 house" / "3 houses". */
export function ownerHousesLine(count: number): string {
  return `${count} ${count === 1 ? "house" : "houses"}`;
}

/**
 * The workspace name at the top of the sidebar (and the phone's header line), opening the list of workspaces the person is a
 * Property owner in. With one workspace it is a plain heading: nothing to switch.
 */
export function OwnerWorkspaceSwitcher({ variant }: { variant: "sidebar" | "mobile" }) {
  const ctx = useOwnerWorkspace();
  const name = ctx?.active?.label ?? "Your properties";
  const triggerClass =
    variant === "sidebar"
      ? "-ml-1.5 flex min-w-0 max-w-full items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-left text-[16px] font-bold tracking-[-0.02em] text-foreground outline-none transition hover:bg-[rgba(17,24,39,0.045)] focus-visible:ring-2 focus-visible:ring-primary/30"
      : "inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-1 text-left text-base font-semibold tracking-[-0.02em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
  const label = ctx?.loading ? (
    <span className="inline-block h-[1em] w-24 animate-pulse rounded-full bg-accent/60 motion-reduce:animate-none" aria-hidden />
  ) : (
    <span className="min-w-0 truncate">{name}</span>
  );
  const many = (ctx?.workspaces.length ?? 0) > 1;
  if (!many) {
    return (
      <span className={cn(triggerClass, "cursor-default hover:bg-transparent")} data-attr="owner-workspace-name">
        {label}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={triggerClass} aria-label={`Switch workspace: ${name}`} data-attr="owner-workspace-switcher">
        {label}
        <ChevronDown className="size-3.5 shrink-0 text-muted" strokeWidth={2} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {ctx!.workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            data-attr="owner-workspace-option"
            onSelect={() => ctx!.select(workspace.id)}
            className="justify-between gap-3"
          >
            <span className="min-w-0 truncate">{workspace.label}</span>
            {workspace.id === ctx!.activeId ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
