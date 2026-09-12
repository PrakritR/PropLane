"use client";

/**
 * Settings → Workspaces.
 *
 * Top: the plan, stated as what it buys — workspaces, properties, team seats —
 * with usage meters and a Free / Pro / Business comparison, so a manager can
 * see in one glance what the next tier changes. Below: one card per workspace
 * with its record meter, its houses, and the managers who have access there.
 * Team membership is managed from Settings → Team; this pane shows the
 * per-workspace roll-up and links across.
 */

import { useState } from "react";
import Link from "next/link";
import { Building2, ChevronDown, ChevronUp, Pencil, Trash2, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { resolvePropertyLabelForId } from "@/lib/manager-portfolio-access";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import {
  WORKSPACE_PLAN_ENTITLEMENTS,
  WORKSPACE_PROPERTY_LIMIT,
  type PortalWorkspace,
  type WorkspacePlan,
  type WorkspacePlanTier,
} from "@/lib/workspaces/types";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "./workspace-provider";

const TIER_ORDER: WorkspacePlanTier[] = ["free", "pro", "business"];

function Meter({
  label,
  used,
  limit,
  dataAttr,
}: {
  label: string;
  used: number;
  limit: number | null;
  dataAttr?: string;
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
        {limit === null ? "No numeric cap" : full ? "Limit reached" : `${limit - used} remaining`}
      </p>
    </div>
  );
}

function PlanCard({ plan }: { plan: WorkspacePlan }) {
  const [compare, setCompare] = useState(false);
  const tierLabel = plan.unknown ? "Plan unavailable" : plan.tier ? WORKSPACE_PLAN_ENTITLEMENTS[plan.tier].label : "Legacy";
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
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-3">
          <Meter label="Workspaces" used={plan.usage.workspaces} limit={plan.workspaceLimit} dataAttr="workspace-meter-workspaces" />
          <Meter label="Properties" used={plan.usage.properties} limit={plan.propertyLimit} dataAttr="workspace-meter-properties" />
          <Meter label="Team members" used={plan.usage.team} limit={plan.teamLimit} dataAttr="workspace-meter-team" />
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
                ["Workspaces", (t: WorkspacePlanTier) => String(WORKSPACE_PLAN_ENTITLEMENTS[t].workspaces)],
                ["Properties (listings)", (t: WorkspacePlanTier) => String(WORKSPACE_PLAN_ENTITLEMENTS[t].properties)],
                ["Records per workspace, drafts included", (t: WorkspacePlanTier) => String(WORKSPACE_PLAN_ENTITLEMENTS[t].recordsPerWorkspace)],
                ["Team members (co-managers)", (t: WorkspacePlanTier) => (WORKSPACE_PLAN_ENTITLEMENTS[t].team ? String(WORKSPACE_PLAN_ENTITLEMENTS[t].team) : "—")],
                ["Vendors", () => "Unlimited"],
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
}: {
  workspace: PortalWorkspace;
  ownedCount: number;
  canManage: boolean;
  onRename: () => void;
  onDelete: () => void;
  onMove: (propertyId: string) => void;
}) {
  const records = workspace.propertyIds.length;
  const pct = Math.min(100, Math.round((records / WORKSPACE_PROPERTY_LIMIT) * 100));
  const members = workspace.members ?? [];
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm" data-attr="workspace-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-primary" aria-hidden>
          <Building2 className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-foreground">{workspace.name}</h3>
          <p className="text-xs text-muted">
            {workspace.owned ? "Owner" : "Shared access"}
            {workspace.isDefault ? " · Default" : ""}
          </p>
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center">
            <Button variant="ghost" className="h-10 w-10 p-0" aria-label={`Rename ${workspace.name}`} title="Rename" onClick={onRename}>
              <Pencil className="size-4" aria-hidden />
            </Button>
            {!workspace.isDefault ? (
              <Button variant="ghost" className="h-10 w-10 p-0 text-red-600" aria-label={`Delete ${workspace.name}`} title="Delete" onClick={onDelete}>
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 border-t border-border px-4 py-3 sm:grid-cols-2">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-foreground">Property records</span>
            <span className="text-sm font-semibold tabular-nums">
              {records}
              <span className="text-muted"> / {WORKSPACE_PROPERTY_LIMIT}</span>
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--secondary)]" aria-hidden>
            <div className={cn("h-full rounded-full", records >= WORKSPACE_PROPERTY_LIMIT ? "bg-[var(--status-pending-fg)]" : "bg-primary")} style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted">Drafts count toward this workspace&apos;s records.</p>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-foreground">Team on this workspace</span>
            <span className="text-sm font-semibold tabular-nums">{workspace.owned ? members.length : "—"}</span>
          </div>
          {workspace.owned ? (
            members.length === 0 ? (
              <p className="mt-1.5 text-xs text-muted">Only you. Invite a manager to share these houses.</p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {members.slice(0, 4).map((member) => (
                  <li key={member.userId} className="flex items-center gap-2 text-xs">
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--secondary)] text-[10px] font-bold text-foreground" aria-hidden>
                      {member.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{member.name}</span>
                    <span className="shrink-0 text-muted">
                      {member.propertyIds.length} {member.propertyIds.length === 1 ? "house" : "houses"} · {member.modules.length} {member.modules.length === 1 ? "module" : "modules"}
                    </span>
                  </li>
                ))}
                {members.length > 4 ? <li className="text-xs text-muted">+{members.length - 4} more</li> : null}
              </ul>
            )
          ) : (
            <p className="mt-1.5 text-xs text-muted">Only the houses and modules granted to you are available here.</p>
          )}
        </div>
      </div>

      <div className="divide-y divide-border border-t border-border">
        {workspace.propertyIds.map((id) => (
          <div key={id} className="flex items-center gap-2 px-4 py-2">
            <Link href={`/portal/properties/listed/${encodeURIComponent(id)}/preview`} className="min-w-0 flex-1 truncate py-1.5 text-sm font-medium text-primary">
              {workspace.propertyLabels?.[id] ?? resolvePropertyLabelForId(id)}
            </Link>
            {canManage && ownedCount > 1 ? (
              <Button variant="ghost" className="h-9 px-2 text-xs" onClick={() => onMove(id)}>
                Move
              </Button>
            ) : null}
          </div>
        ))}
        {workspace.propertyIds.length === 0 ? <p className="px-4 py-3 text-sm text-muted">No properties yet.</p> : null}
      </div>

      {workspace.owned ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
          <Link
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-primary transition hover:bg-accent"
            href="/portal/profile?tab=team"
            data-attr="workspace-manage-team"
          >
            <Users className="size-4" aria-hidden />
            Managers & permissions
          </Link>
          <Link
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-primary transition hover:bg-accent"
            href="/portal/profile?tab=vendors"
            data-attr="workspace-manage-vendors"
          >
            <UserPlus className="size-4" aria-hidden />
            Vendors
          </Link>
        </div>
      ) : null}
    </section>
  );
}

export function WorkspaceSettings({ openNew = false }: { openNew?: boolean } = {}) {
  const ctx = useWorkspaces();
  const confirm = useConfirm();
  // `openNew` is the sidebar's "New workspace" landing here with the form already open.
  const [editing, setEditing] = useState<PortalWorkspace | "new" | null>(openNew ? "new" : null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; destination: string } | null>(null);
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
  return (
    <div className="space-y-4" data-attr="workspace-settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Workspaces</h2>
          <p className="text-sm text-muted">Group your houses, and decide who works in each group.</p>
        </div>
        <Button
          onClick={() => {
            setName("");
            setEditing("new");
          }}
          disabled={atWorkspaceCap || ctx.loading}
          title={atWorkspaceCap ? "Your plan's workspace limit is reached" : undefined}
          data-attr="workspace-add"
        >
          + Add workspace
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {plan ? <PlanCard plan={plan} /> : null}
      {ctx.loading ? (
        <p role="status" className="text-sm text-muted">
          Loading workspaces…
        </p>
      ) : ctx.workspaces.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-4">
          <p className="mb-2 text-sm">Create your first workspace to organize properties and access.</p>
          <Button onClick={() => run({ action: "initialize" })}>Create workspace</Button>
        </div>
      ) : (
        ctx.workspaces.map((workspace) => (
          <WorkspaceCard
            key={workspace.id}
            workspace={workspace}
            ownedCount={owned.length}
            canManage={workspace.owned}
            onRename={() => {
              setName(workspace.name);
              setEditing(workspace);
            }}
            onDelete={async () => {
              if (
                await confirm({
                  title: "Delete workspace?",
                  description: `Delete ${workspace.name}? Move its properties to another workspace first.`,
                  confirmLabel: "Delete",
                })
              )
                await run({ action: "delete", id: workspace.id });
            }}
            onMove={(propertyId) => setMoving({ id: propertyId, destination: owned.find((w) => w.id !== workspace.id)!.id })}
          />
        ))
      )}
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Add workspace" : "Rename workspace"}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run({ action: editing === "new" ? "create" : "rename", id: editing && editing !== "new" ? editing.id : undefined, name }, () => setEditing(null));
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
            <Button variant="ghost" type="button" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => run({ action: editing === "new" ? "create" : "rename", id: editing && editing !== "new" ? editing.id : undefined, name }, () => setEditing(null))}
            >
              Save
            </Button>
          </ModalFooter>
        </form>
      </Modal>
      <Modal open={moving !== null} onClose={() => setMoving(null)} title="Move property">
        <p className="mb-3 text-sm text-muted">Ownership and existing property permissions stay the same.</p>
        <Select aria-label="Destination workspace" value={moving?.destination ?? ""} onChange={(event) => setMoving((value) => value && { ...value, destination: event.target.value })}>
          {owned.map((workspace) => (
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
