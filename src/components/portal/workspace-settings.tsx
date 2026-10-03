"use client";

import { PortalSettingsSection, PortalSettingsGroup, PortalSettingsRow } from "./portal-settings-ui";

/**
 * Settings → Workspaces.
 *
 * Top: the plan, stated as what it buys — workspaces, properties, team seats —
 * with usage meters and a Free / Pro / Business comparison, so a manager can
 * see in one glance what the next tier changes. Below: one card per workspace
 * with its record meter, its houses, and — under "Managers & permissions" — the
 * team on that workspace: you, every co-manager who holds a house there, the
 * pending invites, and that card's Invite. There is no separate Team section;
 * the team panel renders each card's section (see ProAccountLinksPanel's
 * renderWorkspaces). Every owned workspace can be deleted, the default one
 * included: an empty one goes on a plain confirm, one with houses through a
 * dialog that names the workspace they move to.
 *
 * Settings always shows the workspace selected in the sidebar switcher (captain,
 * 2026-10-03): this page has no switcher of its own, and a house is not moved
 * between workspaces from here.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Home, Lock, Pencil } from "lucide-react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { resolvePropertyLabelForId } from "@/lib/manager-portfolio-access";
import {
  WORKSPACE_PLAN_ENTITLEMENTS,
  type PortalWorkspace,
  type WorkspacePlan,
} from "@/lib/workspaces/types";
import { useWorkspaces } from "./workspace-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { ProAccountLinksPanel, type WorkspaceTeamApi } from "@/components/portal/pro-account-links-panel";

function PlanCard({ plan }: { plan: WorkspacePlan }) {
  const tierLabel = plan.unknown ? "Unavailable" : plan.tier ? WORKSPACE_PLAN_ENTITLEMENTS[plan.tier].label : "Legacy";
  return <PortalSettingsSection title="Plan">
    <PortalSettingsGroup>
      <PortalSettingsRow label="Plan"><span>{tierLabel}</span></PortalSettingsRow>
      <PortalSettingsRow label="Workspaces"><span>{plan.unknown ? "Unavailable" : `${plan.usage.workspaces} of ${plan.workspaceLimit}`}</span></PortalSettingsRow>
      <PortalSettingsRow label="Residents"><span>{plan.unknown ? "Unavailable" : `${plan.usage.residents} of ${plan.residentLimit ?? "Unlimited"}`}</span></PortalSettingsRow>
    </PortalSettingsGroup>
  </PortalSettingsSection>;
}

function WorkspaceCard({ workspace, canManage, atWorkspaceCap, onRename, onDelete, onLeave, onNew, teamSection, plan }: {
  workspace: PortalWorkspace; canManage: boolean; atWorkspaceCap: boolean;
  onRename: () => void; onDelete: () => void; onLeave: () => Promise<void>; onNew: () => void;
  teamSection: ReactNode; plan: WorkspacePlan | null;
}) {
  return <div id={`workspace-${workspace.id}`} className="space-y-7" data-attr="workspace-card">
    <PortalSettingsSection title="General"><PortalSettingsGroup>
      <PortalSettingsRow label="Name"><span className="inline-flex items-center gap-2">{workspace.name}{canManage ? <PortalIconAction icon={Pencil} label={`Rename ${workspace.name}`} onClick={onRename} data-attr="workspace-rename" /> : <Lock className="size-3 text-muted" aria-label="Read only" />}</span></PortalSettingsRow>
    </PortalSettingsGroup></PortalSettingsSection>
    {teamSection}
    <PortalSettingsSection title="Properties"><PortalSettingsGroup>
      {workspace.propertyIds.map((id) => {
        const address = workspace.propertyAddresses?.[id];
        return <Link key={id} href={`/portal/properties/listed/${encodeURIComponent(id)}/preview`} className="flex min-h-14 items-center gap-3 border-b border-border px-4 py-2.5 last:border-0" data-attr="workspace-property-row">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-primary" aria-hidden><Home className="size-4" /></span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] text-foreground">{workspace.propertyLabels?.[id] ?? resolvePropertyLabelForId(id)}</span>
            {address ? <span className="block truncate text-xs text-muted">{address}</span> : null}
          </span>
        </Link>;
      })}
      {!workspace.propertyIds.length ? <PortalSettingsRow label="No properties" /> : null}
    </PortalSettingsGroup></PortalSettingsSection>
    {workspace.owned && plan ? <PlanCard plan={plan} /> : null}
    {workspace.owned ? <PortalSettingsGroup>
      <button type="button" className="flex min-h-12 w-full items-center gap-2 px-4 text-left text-[15px] font-semibold text-primary disabled:opacity-50" disabled={atWorkspaceCap} onClick={onNew} data-attr="workspace-new">
        <Plus className="size-4" aria-hidden /> New workspace
      </button>
    </PortalSettingsGroup> : null}
    <PortalSettingsGroup className="border-danger/30">
      <button type="button" className="flex min-h-12 w-full items-center px-4 text-left text-[15px] text-danger" onClick={workspace.owned ? onDelete : () => void onLeave()} data-attr={workspace.owned ? "workspace-delete" : "workspace-leave"}>{workspace.owned ? "Delete workspace" : "Leave workspace"}</button>
    </PortalSettingsGroup>
  </div>;
}

/**
 * The team panel owns the invites and every team modal; the cards only decide
 * where each workspace's section sits. Until the signed-in manager is known the
 * cards render with no team section rather than waiting on it.
 */
function WorkspaceCards({ userId, children }: { userId: string | null; children: (team: WorkspaceTeamApi | null) => ReactNode }) {
  if (!userId) return <>{children(null)}</>;
  return <ProAccountLinksPanel userId={userId} renderWorkspaces={children} />;
}

export function WorkspaceSettings({ openNew = false }: { openNew?: boolean } = {}) {
  const ctx = useWorkspaces();
  const { userId } = useManagerUserId();
  const confirm = useConfirm();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  // `openNew` is the sidebar's "New workspace" landing here with the form already open.
  const [editing, setEditing] = useState<PortalWorkspace | "new" | null>(openNew ? "new" : null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A workspace that still holds houses is deleted through this dialog, which
  // names where the houses go (or, for the only workspace, why they cannot).
  const [deleting, setDeleting] = useState<{ workspace: PortalWorkspace; destination: string | null } | null>(null);
  useEffect(() => {
    if (!openNew) return;
    setName("");
    setEditing("new");
  }, [openNew]);
  // "Invite a manager" in the switcher lands on the active workspace's card;
  // the cards mount after the workspaces load, so the hash is honored here.
  const cardsLoading = ctx?.loading ?? true;
  useEffect(() => {
    if (cardsLoading || typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash.startsWith("#workspace-")) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [cardsLoading]);
  const closeEditor = useCallback(() => {
    setEditing(null);
    if (!openNew || typeof window === "undefined") return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("new");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }, [openNew, pathname, searchParams]);
  if (!ctx) return null;
  const owned = ctx.workspaces.filter((w) => w.owned);
  const plan = ctx.plan;
  const atWorkspaceCap = plan ? !plan.unknown && plan.usage.workspaces >= plan.workspaceLimit : owned.length >= 3;
  const run = async (body: Record<string, unknown>, after?: () => void) => {
    setError(null);
    try {
      await ctx.mutate(body);
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save changes.");
    }
  };
  // Deleting the workspace you are working in moves you to the next one; when
  // none is left the page falls back to the account (server picks no workspace).
  const deleteWorkspace = async (workspace: PortalWorkspace, moveTo?: string | null) => {
    const wasActive = ctx.active?.id === workspace.id;
    await run({ action: "delete", id: workspace.id, moveTo: moveTo ?? undefined }, () => {
      setDeleting(null);
      if (!wasActive) return;
      const next = owned.find((row) => row.id !== workspace.id);
      if (next) void ctx.select(next.id, { href: false });
      else router.refresh();
    });
  };
  return (
    // Bottom room so the last card's ⋯ can scroll clear of the assistant FAB.
    <div className="space-y-4 pb-20" data-attr="workspace-settings">
      <div className="flex items-center justify-end empty:hidden">{!ctx.active ? <PortalPrimaryIconAction label="Add workspace" icon={Plus} disabled={atWorkspaceCap} onClick={() => { setName(""); setEditing("new"); }} /> : null}</div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {ctx.loading ? (
        <ListSkeleton rows={3} showLeading={false} />
      ) : ctx.workspaces.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-4">
          <p className="mb-2 text-sm">Create your first workspace to organize properties and access.</p>
          <Button onClick={() => run({ action: "initialize" })}>Create workspace</Button>
        </div>
      ) : (
        <WorkspaceCards userId={userId}>
          {(team) => (ctx.active ? [ctx.active] : []).map((workspace) => (
          <WorkspaceCard
            key={workspace.id}
            workspace={workspace}
            canManage={workspace.owned}
            atWorkspaceCap={atWorkspaceCap}
            onNew={() => { setName(""); setEditing("new"); }}
            plan={plan}
            onLeave={async () => {
              if (!await confirm({ title: "Leave workspace", description: `Leave ${workspace.name}?`, confirmLabel: "Leave" })) return;
              setError(null);
              try {
                const response = await fetch("/api/pro/account-links", { cache: "no-store" });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error ?? "Could not load membership.");
                const membership = (data.invites ?? []).find((row: { workspaceId?: string; direction?: string; status?: string }) => row.workspaceId === workspace.id && row.direction === "incoming" && row.status === "accepted");
                if (!membership) throw new Error("Workspace membership is unavailable.");
                const result = await fetch(`/api/pro/account-links/${encodeURIComponent(membership.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke" }) });
                const body = await result.json();
                if (!result.ok) throw new Error(body.error ?? "Could not leave workspace.");
                await ctx.refresh();
                const next = ctx.workspaces.find((row) => row.id !== workspace.id);
                if (next) await ctx.select(next.id, { href: false });
                router.refresh();
              } catch (e) { setError(e instanceof Error ? e.message : "Could not leave workspace."); }
            }}
            onRename={() => {
              setName(workspace.name);
              setEditing(workspace);
            }}
            onDelete={async () => {
              if (workspace.propertyIds.length > 0) {
                setError(null);
                setDeleting({ workspace, destination: owned.find((row) => row.id !== workspace.id)?.id ?? null });
                return;
              }
              if (
                await confirm({
                  title: "Delete workspace?",
                  description: `Delete ${workspace.name}? It has no properties, so it will be removed now.`,
                  confirmLabel: "Delete",
                })
              ) {
                await deleteWorkspace(workspace);
              }
            }}
            teamSection={team ? team.section(workspace) : null}
          />
          ))}
        </WorkspaceCards>
      )}
      <Modal open={editing !== null} onClose={closeEditor} title={editing === "new" ? "Add workspace" : "Rename workspace"}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run({ action: editing === "new" ? "create" : "rename", id: editing && editing !== "new" ? editing.id : undefined, name }, closeEditor);
          }}
        >
          <label className="block text-sm font-medium">
            Workspace name
            <Input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <ModalFooter>
            <Button
              type="button"
              onClick={() => run({ action: editing === "new" ? "create" : "rename", id: editing && editing !== "new" ? editing.id : undefined, name }, closeEditor)}
            >
              Save
            </Button>
          </ModalFooter>
        </form>
      </Modal>
      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title={deleting ? `Delete ${deleting.workspace.name}?` : "Delete workspace?"}>
        {deleting ? (
          deleting.destination ? (
            <>
              <p className="mb-3 text-sm text-muted" data-attr="workspace-delete-move-copy">
                {deleting.workspace.propertyIds.length === 1
                  ? "Its house keeps ownership and permissions — it just moves."
                  : `Its ${deleting.workspace.propertyIds.length} houses keep ownership and permissions — they just move.`}
              </p>
              <label className="block text-sm font-medium">
                Move {deleting.workspace.propertyIds.length === 1 ? "1 house" : `${deleting.workspace.propertyIds.length} houses`} to
                <Select
                  aria-label="Destination workspace"
                  value={deleting.destination}
                  onChange={(event) => setDeleting((value) => value && { ...value, destination: event.target.value })}
                  data-attr="workspace-delete-move-to"
                >
                  {owned
                    .filter((workspace) => workspace.id !== deleting.workspace.id)
                    .map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name} · {workspace.propertyIds.length} {workspace.propertyIds.length === 1 ? "house" : "houses"}
                      </option>
                    ))}
                </Select>
              </label>
            </>
          ) : (
            <p className="mb-3 text-sm text-muted" data-attr="workspace-delete-only-copy">
              {deleting.workspace.propertyIds.length === 1 ? "Its house needs" : `Its ${deleting.workspace.propertyIds.length} houses need`} somewhere to go,
              and this is your only workspace. Add another workspace first, then move the houses there when you delete this one.
            </p>
          )
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <ModalFooter>
          
          {deleting?.destination ? (
            <Button variant="danger" onClick={() => deleteWorkspace(deleting.workspace, deleting.destination)} data-attr="workspace-delete-move">
              Move and delete
            </Button>
          ) : (
            <Button
              onClick={() => {
                setDeleting(null);
                setName("");
                setEditing("new");
              }}
              disabled={atWorkspaceCap}
              data-attr="workspace-delete-add-first"
            >
              Add a workspace
            </Button>
          )}
        </ModalFooter>
      </Modal>
    </div>
  );
}
