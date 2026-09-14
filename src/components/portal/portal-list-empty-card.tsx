"use client";

/**
 * The empty state of a list tab (Mobbin polish §15): a titled card that says
 * what appears on this tab, points at a sibling tab that does have something
 * ("5 upcoming — next today 4:42 PM"), and offers the one or two real actions.
 * It replaces the bare dashed "Add" box, which said nothing about why the tab
 * was empty or where the rows had gone.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaces } from "@/components/portal/workspace-provider";

export type PortalListEmptyAction = {
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  dataAttr?: string;
  /** The first action is primary; pass `secondary` for the rest. */
  secondary?: boolean;
};

export type PortalListEmptySibling = {
  /** "5 upcoming — next today 4:42 PM" */
  label: string;
  href: string;
  dataAttr?: string;
};

/**
 * A list in a workspace that holds no homes is empty BECAUSE of the workspace,
 * not because the account has nothing. Saying "Nothing here yet" there reads as
 * lost data, so the card names the workspace, says where the homes actually are
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

export function PortalListEmptyCard({
  title,
  description,
  sibling,
  actions = [],
  icon,
  dataAttr = "portal-list-empty-card",
  workspaceAware = true,
}: {
  title: string;
  description?: string;
  sibling?: PortalListEmptySibling | null;
  actions?: PortalListEmptyAction[];
  icon?: ReactNode;
  dataAttr?: string;
  /** Pass false where the caller writes its own workspace-aware copy. */
  workspaceAware?: boolean;
}) {
  const notice = useEmptyWorkspaceNotice();
  const emptyWorkspace = workspaceAware ? notice : null;
  const shownTitle = emptyWorkspace ? `Nothing in ${emptyWorkspace.name} yet` : title;
  const shownDescription = emptyWorkspace
    ? `${emptyWorkspace.name} holds no homes, so nothing appears here. Your ${emptyWorkspace.elsewhere} ${
        emptyWorkspace.elsewhere === 1 ? "home lives" : "homes live"
      } in another workspace — switch workspaces from the menu at the top of the sidebar, or move homes into ${emptyWorkspace.name}.`
    : description;
  const shownSibling = emptyWorkspace
    ? {
        label: "Manage workspaces · move homes here",
        href: "/portal/profile?tab=workspaces",
        dataAttr: "portal-list-empty-workspaces",
      }
    : sibling;
  // Every action here needs a home to act on, so an empty workspace offers none.
  const shownActions = emptyWorkspace ? [] : actions;
  return (
    <section
      className="flex flex-col items-center rounded-2xl border border-border bg-card px-6 py-8 text-center shadow-sm sm:py-10"
      data-attr={dataAttr}
    >
      {icon ? <span className="mb-3 grid size-11 place-items-center rounded-2xl bg-accent/60 text-primary">{icon}</span> : null}
      <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">{shownTitle}</h3>
      {shownDescription ? <p className="mt-1 max-w-[34rem] text-[13.5px] leading-relaxed text-muted">{shownDescription}</p> : null}
      {shownSibling ? (
        <Link
          href={shownSibling.href}
          data-attr={shownSibling.dataAttr ?? "portal-list-empty-sibling"}
          className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline"
        >
          {shownSibling.label}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}
      {shownActions.length > 0 ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {shownActions.slice(0, 2).map((action) =>
            action.href ? (
              <Button key={action.label} asChild variant={action.secondary ? "outline" : "primary"} className="rounded-full">
                <Link href={action.href} data-attr={action.dataAttr}>
                  {action.label}
                </Link>
              </Button>
            ) : (
              <Button
                key={action.label}
                type="button"
                variant={action.secondary ? "outline" : "primary"}
                className="rounded-full"
                onClick={action.onClick}
                disabled={action.disabled}
                data-attr={action.dataAttr}
              >
                {action.label}
              </Button>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}
