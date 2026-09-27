"use client";

import { TEAM_ROLE_LABELS } from "@/lib/co-manager-team-roles";

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
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRightLeft, Building2, ChevronDown, ChevronUp, Pencil, Trash2 } from "lucide-react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { resolvePropertyLabelForId } from "@/lib/manager-portfolio-access";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import {
  WORKSPACE_PLAN_ENTITLEMENTS,
  type PortalWorkspace,
  type WorkspacePlan,
  type WorkspacePlanTier,
} from "@/lib/workspaces/types";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "./workspace-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { ProAccountLinksPanel, type WorkspaceTeamApi } from "@/components/portal/pro-account-links-panel";

const TIER_ORDER: WorkspacePlanTier[] = ["free", "pro", "business"];

function Meter({
  label,
  used,
  limit,
  dataAttr,
  footnote,
}: {
  label: string;
  used: number;
  limit: number | null;
  dataAttr?: string;
  footnote?: string;
}) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const full = limit !== null && used >= limit;
  return (
    <div className="min-w-0" data-attr={dataAttr}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        <span className={cn("text-sm font-semibold tabular-nums", full ? "text-[var(--status-pending-fg)]" : "text-foreground")}>
          {used}
          <span className="text-muted"> / {limit === null ? "—" : limit}</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--secondary)]" aria-hidden>
        <div className={cn("h-full rounded-full", full ? "bg-[var(--status-pending-fg)]" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">
        {footnote
          ? footnote
          : limit === null
            ? "No numeric cap"
            : full
              ? "Limit reached"
              : `${limit - used} remaining`}
      </p>
    </div>
  );
}

function PlanCard({ plan }: { plan: WorkspacePlan }) {
  const [compare, setCompare] = useState(false);
  const tierLabel = plan.unknown ? "Plan unavailable" : plan.tier ? WORKSPACE_PLAN_ENTITLEMENTS[plan.tier].label : "Legacy";
  const included = plan.tier ? WORKSPACE_PLAN_ENTITLEMENTS[plan.tier].workspaces : null;
  const extras = included != null ? Math.max(0, plan.usage.workspaces - included) : 0;
  return (
    <section className="rounded-2xl border border-border bg-card shadow-sm" data-attr="workspace-plan-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Your plan</p>
          <p className="text-lg font-semibold text-foreground">
            {tierLabel}
            {plan.tier ? <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-primary">Current</span> : null}
          </p>
        </div>
        <Link
          href={MANAGER_PLAN_PORTAL_URL}
          className="inline-flex min-h-10 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-primary transition hover:bg-accent/70"
          data-attr="workspace-plan-view-plans"
        >
          View plans →
        </Link>
      </div>
      {plan.unknown ? (
        <p className="px-4 py-3 text-sm text-muted">We could not verify your plan just now. Limits below are unknown until it loads; nothing was downgraded.</p>
      ) : (
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <Meter
            label="Workspaces"
            used={plan.usage.workspaces}
            limit={plan.workspaceLimit}
            dataAttr="workspace-meter-workspaces"
            footnote={
              included != null && extras > 0
                ? `+${extras} extra beyond ${included} included`
                : included != null
                  ? `${included} included with plan`
                  : undefined
            }
          />
          <Meter
            label="Residents"
            used={plan.usage.residents}
            limit={plan.residentLimit}
            dataAttr="workspace-meter-residents"
          />
        </div>
      )}
      <button
        type="button"
        className="flex w-full items-center justify-between border-t border-border px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-[var(--secondary)]/40"
        aria-expanded={compare}
        onClick={() => setCompare((v) => !v)}
        data-attr="workspace-plan-compare"
      >
        Compare plans
        {compare ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
      </button>
      {compare ? (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.08em] text-muted">
                <th className="px-4 py-2 font-semibold">Includes</th>
                {TIER_ORDER.map((tier) => (
                  <th
                    key={tier}
                    className={cn("px-4 py-2 font-semibold", plan.tier === tier && "text-primary")}
                  >
                    {WORKSPACE_PLAN_ENTITLEMENTS[tier].label}
                    {plan.tier === tier ? " · you" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[
                ["Workspaces included", (t: WorkspacePlanTier) => String(WORKSPACE_PLAN_ENTITLEMENTS[t].workspaces)],
                ["Residents", (t: WorkspacePlanTier) => String(WORKSPACE_PLAN_ENTITLEMENTS[t].residents)],
                ["Extra workspace", (t: WorkspacePlanTier) => (t === "free" ? "—" : t === "pro" ? "$15/mo" : "$30/mo")],
                ["Work number / work email", () => "1 per workspace"],
                ["Properties & team", () => "No plan cap"],
              ].map(([label, cell]) => (
                <tr key={label as string}>
                  <td className="px-4 py-2 text-foreground">{label as string}</td>
                  {TIER_ORDER.map((tier) => (
                    <td key={tier} className={cn("px-4 py-2 tabular-nums", plan.tier === tier ? "font-semibold text-foreground" : "text-muted")}>
                      {(cell as (t: WorkspacePlanTier) => string)(tier)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceCard({
  workspace,
  ownedCount,
  canManage,
  onRename,
  onDelete,
  onMove,
  teamSection,
}: {
  workspace: PortalWorkspace;
  ownedCount: number;
  canManage: boolean;
  onRename: () => void;
  onDelete: () => void;
  onMove: (propertyId: string) => void;
  /** "Managers & permissions" for an owned workspace, rendered by the team panel. */
  teamSection: ReactNode;
}) {
  const records = workspace.propertyIds.length;
  return (
    <section id={`workspace-${workspace.id}`} className="scroll-mt-4 overflow-hidden rounded-2xl border border-border bg-card shadow-sm" data-attr="workspace-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-primary" aria-hidden>
          <Building2 className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-foreground">{workspace.name}</h3>
          <p className="text-xs text-muted">
            {workspace.owned ? "Owner" : workspace.viewerRole && workspace.viewerRole !== "owner" ? TEAM_ROLE_LABELS[workspace.viewerRole] : "Shared access"}
            {workspace.isDefault && workspace.owned ? " · Default" : ""}
            {` · ${records} ${records === 1 ? "house" : "houses"}`}
          </p>
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center">
            <PortalIconAction icon={Pencil} label={`Rename ${workspace.name}`} onClick={onRename} data-attr="workspace-rename" />
            {/* Every owned workspace can go, the default one included; the
                confirm decides where its houses end up. */}
            <PortalIconAction
              icon={Trash2}
              tone="danger"
              label={`Delete ${workspace.name}`}
              onClick={onDelete}
              data-attr="workspace-delete"
            />
          </div>
        ) : null}
      </div>

      <div className="divide-y divide-border border-t border-border">
        {workspace.propertyIds.map((id) => (
          <div key={id} className="flex items-center gap-2 px-4 py-2">
            <Link href={`/portal/properties/listed/${encodeURIComponent(id)}/preview`} className="min-w-0 flex-1 truncate py-1.5 text-sm font-medium text-primary">
              {workspace.propertyLabels?.[id] ?? resolvePropertyLabelForId(id)}
            </Link>
            {(canManage || workspace.canAddProperties) && ownedCount > 1 ? (
              <PortalIconAction icon={ArrowRightLeft} label={`Move ${workspace.propertyLabels?.[id] ?? "this house"} to another workspace`} onClick={() => onMove(id)} data-attr="workspace-move-property" />
            ) : null}
          </div>
        ))}
        {workspace.propertyIds.length === 0 ? <p className="px-4 py-3 text-sm text-muted">No properties yet.</p> : null}
      </div>
      {workspace.owned || workspace.canManageMembers ? (
        teamSection
      ) : (
        <p className="border-t border-border px-4 py-2.5 text-sm text-muted" data-attr="workspace-shared-access">
          Only the houses and modules granted to you are available here. The owner manages who else has access.
        </p>
      )}
    </section>
  );
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
  const [moving, setMoving] = useState<{ id: string; destination: string } | null>(null);
  // Who loses, keeps and gains the house — asked of the server for the chosen
  // destination, so the dialog states the consequence before the click.
  const [moveImpact, setMoveImpact] = useState<{ loses: string[]; keeps: string[]; gains: string[] } | null>(null);
  useEffect(() => {
    if (!moving) {
      setMoveImpact(null);
      return;
    }
    let cancelled = false;
    setMoveImpact(null);
    void (async () => {
      try {
        const response = await fetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "move-preview", id: moving.destination, propertyId: moving.id }),
        });
        const data = (await response.json()) as { loses?: string[]; keeps?: string[]; gains?: string[] };
        if (!cancelled && response.ok) {
          setMoveImpact({ loses: data.loses ?? [], keeps: data.keeps ?? [], gains: data.gains ?? [] });
        }
      } catch {
        /* the dialog still moves; the preview is a courtesy */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [moving]);
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
  // A house moves between workspaces the viewer RUNS: their own, or shared ones
  // where they are an Admin. The destination list is that set, same owner only.
  const movable = ctx.workspaces.filter((w) => w.owned || w.canAddProperties);
  const movingSource = moving ? movable.find((w) => w.propertyIds.includes(moving.id)) ?? null : null;
  const moveTargets = movingSource ? movable.filter((w) => w.ownerUserId === movingSource.ownerUserId) : movable;
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Workspaces</h2>
          <p className="text-sm text-muted">Group your houses, and decide who works in each group.</p>
        </div>
        <PortalPrimaryIconAction
          label="Add workspace"
          icon={Plus}
          // The workspace list still loading is not a reason to disable
          // creating one: the modal below (`editing === "new"`) only needs
          // a name, and pre-disabling on `ctx.loading` — rather than the
          // real plan-limit reason — read as a permanently broken button for
          // that brief window (night UX sweep; matches the modal's own
          // "+" at line ~516 below, which never gated on it either).
          disabled={atWorkspaceCap}
          title={atWorkspaceCap ? "Your plan's workspace limit is reached" : "Add workspace"}
          data-attr="workspace-add"
          onClick={() => {
            setName("");
            setEditing("new");
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {plan ? <PlanCard plan={plan} /> : null}
      {ctx.loading ? (
        <ListSkeleton rows={3} showLeading={false} />
      ) : ctx.workspaces.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-4">
          <p className="mb-2 text-sm">Create your first workspace to organize properties and access.</p>
          <Button onClick={() => run({ action: "initialize" })}>Create workspace</Button>
        </div>
      ) : (
        <WorkspaceCards userId={userId}>
          {(team) => ctx.workspaces.map((workspace) => (
          <WorkspaceCard
            key={workspace.id}
            workspace={workspace}
            ownedCount={movable.filter((w) => w.ownerUserId === workspace.ownerUserId).length}
            canManage={workspace.owned}
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
            onMove={(propertyId) => {
              const target = movable.find((w) => w.id !== workspace.id && w.ownerUserId === workspace.ownerUserId);
              if (target) setMoving({ id: propertyId, destination: target.id });
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
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
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
      <Modal open={moving !== null} onClose={() => setMoving(null)} title={moving ? `Move ${movingSource?.propertyLabels?.[moving.id] ?? "this house"}` : "Move property"}>
        {/* The workspace decides who reaches a house: members on All houses in
            the destination gain it, members of the source lose it unless they
            also sit in the destination. Said before the click, not after. */}
        {moveImpact && (moveImpact.loses.length > 0 || moveImpact.keeps.length > 0 || moveImpact.gains.length > 0) ? (
          <dl className="mb-3 divide-y divide-border rounded-xl border border-border text-sm" data-attr="workspace-move-impact">
            {moveImpact.loses.length > 0 ? (
              <div className="flex items-baseline justify-between gap-3 px-3 py-2"><dt className="text-muted">Loses this house</dt><dd className="text-right font-medium text-foreground">{moveImpact.loses.join(" · ")}</dd></div>
            ) : null}
            {moveImpact.keeps.length > 0 ? (
              <div className="flex items-baseline justify-between gap-3 px-3 py-2"><dt className="text-muted">Keeps it</dt><dd className="text-right font-medium text-foreground">{moveImpact.keeps.join(" · ")}</dd></div>
            ) : null}
            {moveImpact.gains.length > 0 ? (
              <div className="flex items-baseline justify-between gap-3 px-3 py-2"><dt className="text-muted">Gains it</dt><dd className="text-right font-medium text-foreground">{moveImpact.gains.join(" · ")}</dd></div>
            ) : null}
          </dl>
        ) : null}
        <Select aria-label="Destination workspace" value={moving?.destination ?? ""} onChange={(event) => setMoving((value) => value && { ...value, destination: event.target.value })}>
          {moveTargets.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </Select>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <ModalFooter>
          <Button variant="ghost" onClick={() => setMoving(null)}>
            Cancel
          </Button>
          <Button onClick={() => run({ action: "move-property", id: moving?.destination, propertyId: moving?.id }, () => setMoving(null))}>Move</Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
