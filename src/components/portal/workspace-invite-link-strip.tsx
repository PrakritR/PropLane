"use client";

/**
 * Invite link row under Members — same grid/⋯ pattern as team member rows.
 * Edit opens the invite sheet; Copy reveals the URL; Deactivate revokes.
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
import { mintInviteLinkClient, revealInviteLinkClient } from "@/lib/invite-links/mint-invite-link-client";
import { cn } from "@/lib/utils";

type Props = {
  workspaceId: string;
  workspaceName: string;
  propertyIds: string[];
  canManage: boolean;
  /** Opens the invite sheet so Role / Houses can be edited before reminting. */
  onEdit: () => void;
};

const ROW_GRID = "md:grid md:grid-cols-[minmax(0,1.4fr)_110px_minmax(0,1fr)_120px_44px] md:items-center md:gap-x-3";

export function WorkspaceInviteLinkStrip({
  workspaceId,
  workspaceName,
  propertyIds,
  canManage,
  onEdit,
}: Props) {
  const { showToast } = useAppUi();
  const [linkId, setLinkId] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const hydrate = useCallback(async () => {
    try {
      const res = await fetch(`/api/pro/invite-links?workspaceId=${encodeURIComponent(workspaceId)}`, {
        credentials: "include",
      });
      const body = (await res.json().catch(() => ({}))) as { link?: { id?: string } | null };
      if (!res.ok) {
        setLinkId(null);
        setUrl(null);
        setActive(false);
        setLoaded(true);
        return;
      }
      const id = body.link?.id?.trim() || null;
      setLinkId(id);
      setActive(Boolean(id));
      if (id) {
        const revealed = await revealInviteLinkClient(id);
        setUrl(revealed.ok ? revealed.url : null);
      } else {
        setUrl(null);
      }
    } catch {
      setLinkId(null);
      setUrl(null);
      setActive(false);
    } finally {
      setLoaded(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const mintFresh = async (): Promise<string | null> => {
    const minted = await mintInviteLinkClient({
      kind: "manager",
      label: `Invite to ${workspaceName}`,
      workspaceId,
      assignedPropertyIds: propertyIds,
      houseScope: "all",
      teamRole: "viewer",
      replaceActive: true,
    });
    if (!minted.ok) {
      showToast(minted.error);
      return null;
    }
    setLinkId(minted.linkId || null);
    setUrl(minted.url);
    setActive(true);
    return minted.url;
  };

  const copy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let nextUrl = url;
      if (!nextUrl && linkId && active) {
        const revealed = await revealInviteLinkClient(linkId);
        if (revealed.ok) {
          nextUrl = revealed.url;
          setUrl(revealed.url);
        }
      }
      if (!nextUrl) {
        nextUrl = await mintFresh();
        if (!nextUrl) return;
      }
      await navigator.clipboard.writeText(nextUrl);
      showToast("Invite link copied.");
    } catch {
      showToast("Could not copy the invite link.");
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    if (!canManage || busy || !linkId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/pro/invite-links?id=${encodeURIComponent(linkId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(body.error ?? "Could not deactivate the invite link.");
        return;
      }
      setActive(false);
      setLinkId(null);
      setUrl(null);
      showToast("Invite link deactivated.");
    } catch {
      showToast("Could not deactivate the invite link.");
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      const next = await mintFresh();
      if (next) showToast("Invite link activated.");
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) return null;

  const statusLabel = !loaded ? "…" : active ? "Active" : "Off";
  const detail = !loaded
    ? "Loading…"
    : active && url
      ? url
      : "No active invite link";

  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2.5", ROW_GRID)}
      data-attr="workspace-invite-link-strip"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Link2 className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold text-foreground">Invite link</span>
          <span className="block truncate font-mono text-[12px] text-muted" data-attr="workspace-invite-link-url">
            {detail}
          </span>
        </span>
      </span>
      <span>
        <span
          className={cn(
            "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold",
            active ? "bg-primary/10 text-primary" : "bg-[var(--secondary)] text-muted",
          )}
          data-attr="workspace-invite-link-status"
        >
          {statusLabel}
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
            disabled={busy || !loaded}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            data-portal-row-ignore
            data-attr="workspace-invite-link-actions"
          >
            <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-attr="workspace-invite-link-actions-menu">
            <DropdownMenuItem
              data-attr="workspace-invite-link-edit"
              onSelect={() => onEdit()}
            >
              Edit
            </DropdownMenuItem>
            {active ? (
              <DropdownMenuItem data-attr="workspace-invite-link-copy" onSelect={() => void copy()}>
                Copy link
              </DropdownMenuItem>
            ) : null}
            {active ? (
              <DropdownMenuItem
                data-attr="workspace-invite-link-deactivate"
                className="text-[var(--status-overdue-fg)]"
                onSelect={() => void deactivate()}
              >
                Deactivate
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem data-attr="workspace-invite-link-activate" onSelect={() => void activate()}>
                Activate
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );
}
