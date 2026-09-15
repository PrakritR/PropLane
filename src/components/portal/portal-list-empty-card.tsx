"use client";

/**
 * THE empty state of a manager list tab (PLAN-0914-1629). One card, one
 * anatomy, on every tab of every section:
 *
 *   glyph tile · title · sibling link · pill
 *
 * The tile carries the section's own sidebar glyph, the title names the tab
 * ("No tours pending", "Nothing unlisted" — never "Nothing here yet"), the
 * sibling link points at another tab that does have rows ("3 approved →"),
 * and the pill does the same job as the command bar's filled primary. There is
 * deliberately no sentence under the title. "No matches" is the same card in
 * the muted tone with a Clear link instead of the pill.
 *
 * It replaced four different empties: the old titled card, the list surface's
 * "Nothing here yet" fallback, `PortalEmptyState`'s grey tile, and raw
 * paragraphs; `PortalEmptyState` now renders through it.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, Plus, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { cn } from "@/lib/utils";

export type PortalListEmptyAction = {
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  /** Why the pill is disabled — the tooltip; there is no sentence to carry it. */
  reason?: string;
  dataAttr?: string;
  /** The first action is primary; pass `secondary` for the rest. */
  secondary?: boolean;
  /** Glyph before the label. Defaults to a plus for an "Add …" / "New …" label. */
  icon?: LucideIcon | null;
};

export type PortalListEmptySibling = {
  /** "3 approved" */
  label: string;
  /** Routed tab → link; local-state tab → button. */
  href?: string;
  onClick?: () => void;
  dataAttr?: string;
};

/**
 * A list in a workspace that holds no homes is empty BECAUSE of the workspace,
 * not because the account has nothing. Saying "No homes yet" there reads as
 * lost data, so the card names the workspace, points at where the homes are
 * and drops actions that cannot succeed without a home. `null` whenever the
 * account is a single workspace, since then the workspace IS the account.
 */
function useEmptyWorkspaceNotice(): { name: string; elsewhere: number } | null {
  const ctx = useWorkspaces();
  const active = ctx?.active ?? null;
  if (!ctx || !active || ctx.workspaces.length <= 1) return null;
  if (active.propertyIds.length > 0) return null;
  const elsewhere = ctx.workspaces
    .filter((w) => w.id !== active.id)
    .reduce((n, w) => n + w.propertyIds.length, 0);
  if (elsewhere === 0) return null;
  return { name: active.name, elsewhere };
}

const ADD_LABEL = /^(add|new|create|schedule|upload|invite|log|record)\b/i;

export function PortalListEmptyCard({
  title,
  section,
  icon,
  tone = "default",
  sibling,
  actions = [],
  clear,
  dataAttr = "portal-list-empty-card",
  workspaceAware = true,
  compact = false,
  className,
  children,
}: {
  title: string;
  /** Sidebar section whose glyph fills the tile ("properties", "tours", …). */
  section?: string;
  /** A custom glyph for the tile when the card is not a section's tab. */
  icon?: ReactNode;
  /** `muted` is the no-match / nothing-to-do tone: grey tile, no pill. */
  tone?: "default" | "muted";
  /** @deprecated No sentence is drawn under the title any more. */
  description?: string;
  sibling?: PortalListEmptySibling | null;
  actions?: PortalListEmptyAction[];
  /** The no-match escape: "Clear search" / "Clear filters". Drawn instead of the pill. */
  clear?: { label: string; onClick: () => void; dataAttr?: string } | null;
  dataAttr?: string;
  /** Pass false where the caller writes its own workspace-aware copy. */
  workspaceAware?: boolean;
  /** Tighter padding inside a narrow column (the conversation list). */
  compact?: boolean;
  className?: string;
  /** A caller-owned action node (legacy `PortalEmptyState action`); prefer `actions`. */
  children?: ReactNode;
}) {
  const notice = useEmptyWorkspaceNotice();
  const emptyWorkspace = workspaceAware ? notice : null;
  const shownTitle = emptyWorkspace ? `Nothing in ${emptyWorkspace.name} yet` : title;
  const shownSibling = emptyWorkspace
    ? {
        label: `${emptyWorkspace.elsewhere} ${emptyWorkspace.elsewhere === 1 ? "home" : "homes"} in other workspaces`,
        href: "/portal/profile?tab=workspaces",
        dataAttr: "portal-list-empty-workspaces",
      }
    : sibling;
  // Every action here needs a home to act on, so an empty workspace offers none.
  const shownActions = emptyWorkspace || tone === "muted" ? [] : actions;
  const tileNode =
    icon ?? (section ? <PortalNavIcon section={section} className="size-[22px]" strokeWidth={1.6} /> : null);
  return (
    <section
      className={cn(
        "flex flex-col items-center rounded-2xl border border-border bg-card px-6 text-center shadow-sm",
        compact ? "py-7" : "py-9 sm:py-10",
        className,
      )}
      data-attr={dataAttr}
      data-tone={tone}
    >
      {tileNode ? (
        <span
          className={cn(
            "mb-3.5 grid size-12 place-items-center rounded-[14px]",
            tone === "muted" ? "bg-[var(--secondary)] text-muted/70" : "bg-accent/70 text-primary",
          )}
          data-slot="portal-list-empty-tile"
        >
          {tileNode}
        </span>
      ) : null}
      <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">{shownTitle}</h3>
      {shownSibling?.href ? (
        <Link
          href={shownSibling.href}
          data-attr={shownSibling.dataAttr ?? "portal-list-empty-sibling"}
          className="mt-2.5 inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline"
        >
          {shownSibling.label}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : shownSibling?.onClick ? (
        <button
          type="button"
          onClick={shownSibling.onClick}
          data-attr={shownSibling.dataAttr ?? "portal-list-empty-sibling"}
          className="mt-2.5 inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline"
        >
          {shownSibling.label}
          <ArrowRight className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {clear ? (
        <button
          type="button"
          onClick={clear.onClick}
          data-attr={clear.dataAttr ?? "portal-list-empty-clear"}
          className="mt-2.5 inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline"
        >
          <X className="size-3.5" aria-hidden />
          {clear.label}
        </button>
      ) : null}
      {shownActions.length > 0 ? (
        <div className="mt-[18px] flex flex-wrap items-center justify-center gap-2">
          {shownActions.slice(0, 2).map((action) => {
            const Icon = action.icon === null ? null : (action.icon ?? (ADD_LABEL.test(action.label) ? Plus : null));
            const body = (
              <>
                {Icon ? <Icon className="size-4" strokeWidth={2.2} aria-hidden /> : null}
                {action.label}
              </>
            );
            const tooltip = action.disabled ? action.reason : undefined;
            return action.href && !action.disabled ? (
              <Button key={action.label} asChild variant={action.secondary ? "outline" : "primary"} className="rounded-full gap-1.5">
                <Link href={action.href} data-attr={action.dataAttr} title={tooltip}>
                  {body}
                </Link>
              </Button>
            ) : (
              <span key={action.label} className="inline-flex" title={tooltip}>
                <Button
                  type="button"
                  variant={action.secondary ? "outline" : "primary"}
                  className="rounded-full gap-1.5"
                  onClick={action.onClick}
                  disabled={action.disabled}
                  title={tooltip}
                  aria-disabled={action.disabled || undefined}
                  data-attr={action.dataAttr}
                >
                  {body}
                </Button>
              </span>
            );
          })}
        </div>
      ) : null}
      {children ? <div className="mt-[18px]">{children}</div> : null}
    </section>
  );
}
