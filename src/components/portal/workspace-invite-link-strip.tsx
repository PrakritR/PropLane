"use client";

/**
 * Saved invite links under Members — one row per live minted link.
 * Edit opens the invite sheet; Copy reveals the URL; Delete revokes the link
 * and removes the row (deactivated links are never listed).
 */

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, MoreHorizontal } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
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
import type { PortalWorkspace } from "@/lib/workspaces/types";
import { TeamRowValues } from "./pro-team-blocks";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { WorkspacePermissionsFields, CoManagerPermissionsEditor, WorkspaceGrantFields } from "./workspace-permissions-fields";
import { normalizeCoManagerPermissions, type CoManagerPermissions, type PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";
import { stampTeamRolePermissions, type TeamRoleId } from "@/lib/co-manager-team-roles";
import type { WorkspaceCoManagerGrant } from "@/lib/workspace-co-manager-permissions";

type SavedLink = {
  propertyPermissions?: PropertyCoManagerPermissions;
  workspacePermissions?: WorkspaceCoManagerGrant;
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
  workspace?: PortalWorkspace;
  canManage: boolean;
  /** Bump after Copy and save so the list reloads. */
  refreshKey?: number;
  /** Opens the invite sheet so Role / Houses can be edited before saving another. */
  onEdit: () => void;
};

function isActive(link: SavedLink): boolean {
  return !inviteLinkUnusableReason(link, new Date());
}

export function WorkspaceInviteLinkStrip({
  workspaceId,
  workspace,
  canManage,
  refreshKey = 0,
  onEdit,
}: Props) {
  const { showToast } = useAppUi();
  const [links, setLinks] = useState<SavedLink[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [editing, setEditing] = useState<SavedLink | null>(null);
  const [editRole, setEditRole] = useState<TeamRoleId>("viewer");
  const [editScope, setEditScope] = useState<"all" | "selected">("all");
  const [editHouses, setEditHouses] = useState<string[]>([]);
  const [editGrant, setEditGrant] = useState<CoManagerPermissions>({});
  const [editWorkspace, setEditWorkspace] = useState<WorkspaceCoManagerGrant>({});
  const openEditor = (link: SavedLink, custom = false) => {
    setEditing(link); setEditRole(custom ? "custom" : (link.teamRole ?? "viewer") as TeamRoleId);
    setEditScope(link.houseScope ?? "selected"); setEditHouses(link.assignedPropertyIds);
    setEditGrant(normalizeCoManagerPermissions(link.propertyPermissions?.[link.assignedPropertyIds[0]]));
    setEditWorkspace(link.workspacePermissions ?? {});
  };
  const updateLink = async (link: SavedLink, changes: Record<string, unknown>) => {
    if (!canManage) return;
    setBusyId(link.id);
    try {
      const res = await fetch("/api/pro/invite-links", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: link.id, workspaceId, ...changes }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not update invite link.");
      setLinks((rows) => rows.map((row) => row.id === link.id ? data.link : row));
      setUrls((current) => ({ ...current, [data.link.id]: data.url }));
      setEditing(null);
      showToast("Saved. Copy the replacement link; the previous URL is no longer active.");
    } catch (error) { showToast(error instanceof Error ? error.message : "Could not update invite link."); }
    finally { setBusyId(null); }
  };

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
      {links.map((link) => {
        const url = urls[link.id];
        const busy = busyId === link.id;
        return (
          <div
            key={link.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3"
            data-attr="workspace-invite-link-row"
            data-link-id={link.id}
          >
            <span className="flex min-w-[8rem] flex-1 items-center gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                <Link2 className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[15px] text-foreground">Anyone with the link</span>
                <span
                  className="block truncate font-mono text-[12px] text-muted"
                  data-attr="workspace-invite-link-url"
                >
                  {url ?? "Invite link"}
                </span>
              </span>
            </span>
            <TeamRowValues row={{ id: link.id, name: "Invite link", detail: "", role: "co_manager", roleLabel: teamRoleListLabel(link.teamRole), roleId: link.teamRole, propertiesLabel: link.houseScope === "all" ? "All houses" : `${link.assignedPropertyIds.length} houses`, joinedAt: null,
              onEdit: () => openEditor(link, true),
              onRoleChange: async (role) => { await updateLink(link, { teamRole: role }); },
            }} />
            <PortalIconAction icon={Copy} label="Copy invite link" disabled={busy} onClick={() => void copy(link)} data-attr="workspace-invite-link-copy" />
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
                <DropdownMenuItem data-attr="workspace-invite-link-edit" onSelect={() => workspace ? openEditor(link) : onEdit()}>
                  Permissions
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
          </div>
        );
      })}
      <Modal title="Invite link permissions" open={editing !== null} onClose={() => setEditing(null)}>
        <div className="space-y-4"><WorkspacePermissionsFields role={editRole} onRoleChange={(role) => { setEditRole(role); const grant = stampTeamRolePermissions(role); if (grant) setEditGrant(grant); }} houseScope={editScope} onHouseScopeChange={setEditScope} selectedHouseIds={editHouses} onSelectedHouseIdsChange={setEditHouses} workspace={workspace ? { name: workspace.name, houseCount: workspace.propertyIds.length } : null} houseOptions={(workspace?.propertyIds ?? []).map((id) => ({ value: id, label: workspace?.propertyLabels?.[id] ?? id }))} />
        {editRole === "custom" ? <><CoManagerPermissionsEditor hideRole value={editGrant} onChange={setEditGrant} /><WorkspaceGrantFields value={editWorkspace} onChange={setEditWorkspace} /></> : null}</div>
        <ModalFooter><Button disabled={busyId !== null || (editScope === "selected" && !editHouses.length)} onClick={async () => { if (!editing) return; const ids = editScope === "all" ? workspace?.propertyIds ?? [] : editHouses; await updateLink(editing, { teamRole: editRole, houseScope: editScope, assignedPropertyIds: ids, propertyPermissions: Object.fromEntries(ids.map((id) => [id, editGrant])), workspacePermissions: editWorkspace }); }}>Save</Button></ModalFooter>
      </Modal>
    </div>
  );
}
