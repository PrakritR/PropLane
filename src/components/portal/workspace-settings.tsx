"use client";

import { useState } from "react";
import Link from "next/link";
import { Pencil, Trash2, Users, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { resolvePropertyLabelForId } from "@/lib/manager-portfolio-access";
import { WORKSPACE_LIMIT, WORKSPACE_PROPERTY_LIMIT, type PortalWorkspace } from "@/lib/workspaces/types";
import { useWorkspaces } from "./workspace-provider";

export function WorkspaceSettings() {
  const ctx = useWorkspaces();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<PortalWorkspace | "new" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; destination: string } | null>(null);
  if (!ctx) return null;
  const owned = ctx.workspaces.filter((w) => w.owned);
  const run = async (body: Record<string, unknown>, after?: () => void) => {
    setError(null);
    try { await ctx.mutate(body); after?.(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save changes."); }
  };
  return (
    <div className="space-y-4" data-attr="workspace-settings">
      <div className="flex items-center justify-between gap-2">
        <div><h2 className="text-lg font-semibold">Workspaces</h2><p className="text-sm text-muted">{owned.length} / {WORKSPACE_LIMIT} owned · {WORKSPACE_PROPERTY_LIMIT} properties each, including drafts</p></div>
        <Button onClick={() => { setName(""); setEditing("new"); }} disabled={owned.length >= WORKSPACE_LIMIT || ctx.loading}>Add workspace</Button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {ctx.loading ? <p role="status">Loading workspaces…</p> : !ctx.workspaces.length ? (
        <div className="rounded-xl border border-dashed border-border p-4"><p className="mb-2 text-sm">Create your first workspace to organize properties and access.</p><Button onClick={() => run({ action: "initialize" })}>Create workspace</Button></div>
      ) : ctx.workspaces.map((workspace) => (
        <section key={workspace.id} className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Building2 className="size-5 text-primary" aria-hidden />
            <div className="min-w-0 flex-1"><h3 className="truncate font-semibold">{workspace.name}</h3><p className="text-xs text-muted">{workspace.owned ? "Owner" : "Shared access"} · {workspace.propertyIds.length} / {WORKSPACE_PROPERTY_LIMIT} properties</p></div>
            {workspace.owned && <>
              <Button variant="ghost" className="h-11 w-11 p-0" aria-label={`Rename ${workspace.name}`} title="Rename" onClick={() => { setName(workspace.name); setEditing(workspace); }}><Pencil className="size-4" aria-hidden /></Button>
              {!workspace.isDefault && <Button variant="danger" className="h-11 w-11 p-0" aria-label={`Delete ${workspace.name}`} title="Delete" onClick={async () => {
                if (await confirm({ title: "Delete workspace?", description: `Delete ${workspace.name}? Move its properties to another workspace first.`, confirmLabel: "Delete" })) await run({ action: "delete", id: workspace.id });
              }}><Trash2 className="size-4" aria-hidden /></Button>}
            </>}
          </div>
          <div className="divide-y divide-border">
            {workspace.propertyIds.map((id) => <div key={id} className="flex items-center gap-2 px-3 py-2">
              <Link href={`/portal/properties/listed/${encodeURIComponent(id)}/preview`} className="min-w-0 flex-1 truncate py-2 text-sm font-medium text-primary">{resolvePropertyLabelForId(id)}</Link>
              {workspace.owned && owned.length > 1 && <Button variant="ghost" onClick={() => setMoving({ id, destination: owned.find((w) => w.id !== workspace.id)!.id })}>Move</Button>}
            </div>)}
            {!workspace.propertyIds.length && <p className="p-3 text-sm text-muted">No properties yet.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-sm">
            <Link className="inline-flex min-h-11 items-center gap-2 text-primary" href="/portal/teams/managers"><Users className="size-4" aria-hidden />Managers & permissions</Link>
            <Link className="inline-flex min-h-11 items-center text-primary" href="/portal/teams/vendors">Vendors & sharing</Link>
          </div>
          {!workspace.owned && <p className="px-3 pb-3 text-xs text-muted">Only explicitly granted properties and modules are available. Empty permissions mean no access.</p>}
        </section>
      ))}
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Add workspace" : "Rename workspace"}>
        <form onSubmit={(event) => { event.preventDefault(); void run({ action: editing === "new" ? "create" : "rename", id: editing && editing !== "new" ? editing.id : undefined, name }, () => setEditing(null)); }}>
          <label className="block text-sm font-medium">Workspace name<Input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
          <ModalFooter><Button variant="ghost" type="button" onClick={() => setEditing(null)}>Cancel</Button><Button type="button" onClick={() => run({ action: editing === "new" ? "create" : "rename", id: editing && editing !== "new" ? editing.id : undefined, name }, () => setEditing(null))}>Save</Button></ModalFooter>
        </form>
      </Modal>
      <Modal open={moving !== null} onClose={() => setMoving(null)} title="Move property">
        <p className="mb-3 text-sm text-muted">Ownership and existing property permissions stay the same.</p>
        <Select aria-label="Destination workspace" value={moving?.destination ?? ""} onChange={(event) => setMoving((value) => value && ({ ...value, destination: event.target.value }))}>
          {owned.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </Select>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <ModalFooter><Button variant="ghost" onClick={() => setMoving(null)}>Cancel</Button><Button onClick={() => run({ action: "move-property", id: moving?.destination, propertyId: moving?.id }, () => setMoving(null))}>Move</Button></ModalFooter>
      </Modal>
    </div>
  );
}
