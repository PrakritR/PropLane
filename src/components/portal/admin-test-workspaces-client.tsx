"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { Button } from "@/components/ui/button";

type TestWorkspaceMember = {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  role: "manager" | "co_manager" | "resident";
  state: "active" | "suspended";
  expiresAt: string | null;
  createdAt: string;
};

type TestWorkspace = {
  id: string;
  name: string;
  status: "active" | "suspended";
  createdAt: string;
  members: TestWorkspaceMember[];
};

type CreateMode = { kind: "workspace" } | { kind: "member"; workspaceId: string } | null;

const PRIVATE_FETCH: RequestInit = { cache: "no-store", credentials: "same-origin" };

async function fetchTestWorkspaces(): Promise<TestWorkspace[]> {
  const response = await fetch("/api/admin/test-workspaces", PRIVATE_FETCH);
  const body = await response.json().catch(() => ({})) as { workspaces?: TestWorkspace[]; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not load test workspaces.");
  return Array.isArray(body.workspaces) ? body.workspaces : [];
}

export function AdminTestWorkspacesClient() {
  const { showToast } = useAppUi();
  const [workspaces, setWorkspaces] = useState<TestWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviteRoles, setInviteRoles] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const nextWorkspaces = await fetchTestWorkspaces();
      setLoadError(null);
      setWorkspaces(nextWorkspaces);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load test workspaces.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void fetchTestWorkspaces()
      .then((nextWorkspaces) => {
        if (!current) return;
        setLoadError(null);
        setWorkspaces(nextWorkspaces);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setLoadError(error instanceof Error ? error.message : "Could not load test workspaces.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => { current = false; };
  }, []);

  const memberCount = useMemo(
    () => workspaces.reduce((total, workspace) => total + workspace.members.length, 0),
    [workspaces],
  );

  async function createWorkspace(form: FormData) {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return;
    setBusyId("create-workspace");
    try {
      const response = await fetch("/api/admin/test-workspaces", {
        ...PRIVATE_FETCH,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_workspace", name }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not create the test workspace.");
      setCreateMode(null);
      showToast("Test workspace created.");
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not create the test workspace.");
    } finally {
      setBusyId(null);
    }
  }

  async function inviteMember(workspaceId: string, form: FormData) {
    const email = String(form.get("email") ?? "").trim();
    const fullName = String(form.get("fullName") ?? "").trim();
    const role = String(form.get("role") ?? "resident");
    const expiresAt = String(form.get("expiresAt") ?? "").trim() || null;
    if (!email || !fullName || !["manager", "co_manager", "resident"].includes(role)) return;
    setBusyId(`invite:${workspaceId}`);
    try {
      const response = await fetch("/api/admin/test-workspaces", {
        ...PRIVATE_FETCH,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "invite_member", workspaceId, email, fullName, role, expiresAt }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not invite the test account.");
      setCreateMode(null);
      showToast("Private test account invitation sent.");
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not invite the test account.");
    } finally {
      setBusyId(null);
    }
  }

  async function setMemberState(member: TestWorkspaceMember) {
    const nextState = member.state === "active" ? "suspended" : "active";
    setBusyId(member.id);
    try {
      const response = await fetch("/api/admin/test-workspaces", {
        ...PRIVATE_FETCH,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ membershipId: member.id, state: nextState }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not update the test account.");
      showToast(nextState === "suspended" ? "Test account suspended." : "Test account restored.");
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not update the test account.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ManagerPortalPageShell
      title="Test accounts"
      subtitle="Private workspaces for trusted operators to exercise the deployed portals without reaching customer data or providers."
      count={memberCount}
      titleAside={
        <Button type="button" onClick={() => setCreateMode({ kind: "workspace" })} data-attr="test-workspace-create">
          Create workspace
        </Button>
      }
      hideTitleOnMobileNav
    >
      {createMode?.kind === "workspace" ? (
        <form
          className="mb-4 grid gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
          action={(form) => void createWorkspace(form)}
          aria-busy={busyId === "create-workspace"}
        >
          <label className="grid gap-1.5 text-sm font-medium text-foreground" htmlFor="test-workspace-name">
            Workspace name
            <input
              id="test-workspace-name"
              name="name"
              required
              autoComplete="off"
              spellCheck={false}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              placeholder="Leasing QA"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busyId !== null}>{busyId ? "Creating…" : "Create"}</Button>
            <Button type="button" variant="outline" onClick={() => setCreateMode(null)} disabled={busyId !== null}>Cancel</Button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div className="space-y-2" role="status" aria-label="Loading test workspaces">
          <div className="h-20 animate-pulse rounded-2xl bg-foreground/5" />
          <div className="h-20 animate-pulse rounded-2xl bg-foreground/5" />
        </div>
      ) : loadError ? (
        <div className="rounded-2xl border px-4 py-3 text-sm portal-banner-danger" role="alert">
          <p>{loadError}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-3"
            onClick={() => {
              setLoading(true);
              setLoadError(null);
              void load();
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <PortalRecordListSurface
          isEmpty={workspaces.length === 0}
          empty={<PortalDataTableEmpty icon="data" message="No private test workspaces yet" />}
          dataAttr="admin-test-workspace-list"
        >
          {workspaces.map((workspace) => {
            const open = expandedId === workspace.id;
            const activeMembers = workspace.members.filter((member) => member.state === "active").length;
            return (
              <div key={workspace.id}>
                <PortalPersonRecordRow
                  name={workspace.name}
                  subtitle={`${activeMembers} active of ${workspace.members.length} accounts`}
                  preview="Dedicated test data and captured external effects"
                  meta={workspace.status === "active" ? "Active" : "Suspended"}
                  selected={open}
                  onOpen={() => setExpandedId(open ? null : workspace.id)}
                  dataAttr="admin-test-workspace-row"
                  trailing={<ShieldCheck className="h-5 w-5 text-primary" aria-hidden />}
                />
                {open ? (
                  <div className="border-b border-border/50 bg-accent/10 px-4 py-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-foreground">Workspace accounts</p>
                      <Button type="button" variant="outline" onClick={() => setCreateMode({ kind: "member", workspaceId: workspace.id })}>
                        Invite account
                      </Button>
                    </div>
                    {createMode?.kind === "member" && createMode.workspaceId === workspace.id ? (
                      <form
                        className="mb-4 grid gap-3 rounded-xl border border-border bg-background p-3 md:grid-cols-2"
                        action={(form) => void inviteMember(workspace.id, form)}
                        aria-busy={busyId === `invite:${workspace.id}`}
                      >
                        <label className="grid gap-1 text-xs font-semibold text-foreground" htmlFor={`test-name-${workspace.id}`}>
                          Full name
                          <input id={`test-name-${workspace.id}`} name="fullName" required autoComplete="name" className="h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40" />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold text-foreground" htmlFor={`test-email-${workspace.id}`}>
                          Controlled email
                          <input id={`test-email-${workspace.id}`} name="email" type="email" required autoComplete="email" spellCheck={false} className="h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40" />
                        </label>
                        <div className="grid gap-1">
                          <PortalFormSingleSelect
                            label="Portal role"
                            value={inviteRoles[workspace.id] ?? "resident"}
                            onChange={(role) => setInviteRoles((current) => ({ ...current, [workspace.id]: role }))}
                            options={[
                              { value: "resident", label: "Resident" },
                              { value: "manager", label: "Manager" },
                              { value: "co_manager", label: "Co-manager" },
                            ]}
                            dataAttr="test-workspace-member-role"
                            labelClassName="block text-xs font-semibold text-foreground"
                          />
                          <input type="hidden" name="role" value={inviteRoles[workspace.id] ?? "resident"} />
                        </div>
                        <label className="grid gap-1 text-xs font-semibold text-foreground" htmlFor={`test-expiry-${workspace.id}`}>
                          Expiry (optional)
                          <input id={`test-expiry-${workspace.id}`} name="expiresAt" type="datetime-local" className="h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40" />
                        </label>
                        <div className="flex gap-2 md:col-span-2">
                          <Button type="submit" disabled={busyId !== null}>{busyId ? "Sending…" : "Send private invite"}</Button>
                          <Button type="button" variant="outline" onClick={() => setCreateMode(null)} disabled={busyId !== null}>Cancel</Button>
                        </div>
                      </form>
                    ) : null}
                    {workspace.members.length === 0 ? (
                      <p className="text-sm text-muted">No accounts have been invited to this workspace.</p>
                    ) : (
                      <div className="divide-y divide-border/50">
                        {workspace.members.map((member) => (
                          <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-foreground">{member.fullName || member.email}</p>
                              <p className="truncate text-xs text-muted">{member.email} · {member.role} · {member.state}</p>
                            </div>
                            <Button type="button" variant="outline" disabled={busyId !== null} onClick={() => void setMemberState(member)}>
                              {busyId === member.id ? "Updating…" : member.state === "active" ? "Suspend" : "Restore"}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </PortalRecordListSurface>
      )}
    </ManagerPortalPageShell>
  );
}
