"use client";

/**
 * Saved invite links under Members — one row per live minted link.
 * Edit opens the invite sheet; Copy reveals the URL; Delete revokes the link
 * and removes the row (deactivated links are never listed).
 */

import { useCallback, useEffect, useState } from "react";
import { Link2, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { revealInviteLinkClient } from "@/lib/invite-links/mint-invite-link-client";
import { inviteLinkUnusableReason } from "@/lib/invite-links/invite-link-model";
import { teamRoleListLabel } from "@/lib/co-manager-team-roles";
import { cn } from "@/lib/utils";

type SavedLink = {
  id: string;
  label: string | null;
  teamRole?: string | null;
  houseScope?: "all" | "selected" | null;
  assignedPropertyIds: string[];
  revokedAt: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  usedCount: number;
  createdAt: string;
};

type Props = {
  workspaceId: string;
  canManage: boolean;
  /** Bump after Copy and save so the list reloads. */
  refreshKey?: number;
  /** Opens the invite sheet so Role / Houses can be edited before saving another. */
  onEdit: () => void;
};

const ROW_GRID = "md:grid md:grid-cols-[minmax(0,1.4fr)_110px_minmax(0,1fr)_120px_44px] md:items-center md:gap-x-3";

function linkTitle(link: SavedLink): string {
  const trimmed = link.label?.trim();
  if (trimmed) return trimmed;
  const role = teamRoleListLabel(link.teamRole);
  if (link.houseScope === "all") return `${role} · All houses`;
  const n = link.assignedPropertyIds.length;
  return `${role} · ${n === 1 ? "1 house" : `${n} houses`}`;
}

function isActive(link: SavedLink): boolean {
  return !inviteLinkUnusableReason(link, new Date());
}

export function WorkspaceInviteLinkStrip({
  workspaceId,
  canManage,
  refreshKey = 0,
  onEdit,
}: Props) {
  const { showToast } = useAppUi();
  const [links, setLinks] = useState<SavedLink[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const hydrate = useCallback(async () => {
    try {
      const res = await fetch(`/api/pro/invite-links?workspaceId=${encodeURIComponent(workspaceId)}`, {
        credentials: "include",
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as {
        links?: SavedLink[];
        link?: { id?: string } | null;
      };
      if (!res.ok) {
        setLinks([]);
        setLoaded(true);
        return;
      }
      const next = (Array.isArray(body.links) ? body.links : []).filter(isActive);
      setLinks(next);
      // Eager-reveal active URLs for the list preview (tokens stay server-side until reveal).
      const revealed: Record<string, string> = {};
      await Promise.all(
        next.filter(isActive).slice(0, 10).map(async (link) => {
          const result = await revealInviteLinkClient(link.id);
          if (result.ok) revealed[link.id] = result.url;
        }),
      );
      setUrls(revealed);
    } catch {
      setLinks([]);
    } finally {
      setLoaded(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    void hydrate();
  }, [hydrate, refreshKey]);

  const copy = async (link: SavedLink) => {
    if (busyId) return;
    setBusyId(link.id);
    try {
      let nextUrl = urls[link.id];
      if (!nextUrl) {
        const revealed = await revealInviteLinkClient(link.id);
        if (!revealed.ok) {
          showToast(revealed.error);
          return;
        }
        nextUrl = revealed.url;
        setUrls((prev) => ({ ...prev, [link.id]: revealed.url }));
      }
      await navigator.clipboard.writeText(nextUrl);
      showToast("Invite link copied.");
    } catch {
      showToast("Could not copy the invite link.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (link: SavedLink) => {
    if (!canManage || busyId || !isActive(link)) return;
    setBusyId(link.id);
    try {
      const res = await fetch(`/api/pro/invite-links?id=${encodeURIComponent(link.id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(body.error ?? "Could not delete the invite link.");
        return;
      }
      setLinks((prev) => prev.filter((row) => row.id !== link.id));
      setUrls((prev) => {
        const next = { ...prev };
        delete next[link.id];
        return next;
      });
      showToast("Invite link deleted.");
    } catch {
      showToast("Could not delete the invite link.");
    } finally {
      setBusyId(null);
    }
  };

  if (!canManage) return null;
  if (!loaded) {
    return (
      <div className="space-y-2 border-t border-border/60 px-4 py-3" role="status" aria-label="Loading invite links">
        <div className="h-3 w-1/3 rounded-lg bg-[var(--secondary)]" />
        <div className="h-3 w-1/2 rounded-lg bg-[var(--secondary)]" />
      </div>
    );
  }
  if (links.length === 0) return null;

  return (
    <div data-attr="workspace-invite-link-strip">
      <div
        className="border-t border-border/60 px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted"
        data-attr="workspace-invite-links-heading"
      >
        Invite links
      </div>
      {links.map((link) => {
        const url = urls[link.id];
        const busy = busyId === link.id;
        return (
          <div
            key={link.id}
            className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2.5", ROW_GRID)}
            data-attr="workspace-invite-link-row"
            data-link-id={link.id}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                <Link2 className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-semibold text-foreground">{linkTitle(link)}</span>
                <span
                  className="block truncate font-mono text-[12px] text-muted"
                  data-attr="workspace-invite-link-url"
                >
                  {url ?? "Invite link"}
                </span>
              </span>
            </span>
            <span>
              <span
                className="inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary"
                data-attr="workspace-invite-link-status"
              >
                Active
              </span>
            </span>
            <span className="min-w-0 truncate text-[13px] text-foreground max-md:basis-full max-md:text-[12px] max-md:text-muted">
              Anyone with the link
            </span>
            <span className="text-[12.5px] text-muted max-md:hidden">—</span>
            <span className="ml-auto md:ml-0 md:justify-self-end">
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger
                  type="button"
                  aria-label="Invite link actions"
                  disabled={busy}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                  data-portal-row-ignore
                  data-attr="workspace-invite-link-actions"
                >
                  <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" data-attr="workspace-invite-link-actions-menu">
                  <DropdownMenuItem data-attr="workspace-invite-link-edit" onSelect={() => onEdit()}>
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem data-attr="workspace-invite-link-copy" onSelect={() => void copy(link)}>
                    Copy link
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-attr="workspace-invite-link-delete"
                    className="text-[var(--status-overdue-fg)]"
                    onSelect={() => void remove(link)}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
        );
      })}
    </div>
  );
}
