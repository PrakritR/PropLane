"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Settings, ShieldCheck } from "lucide-react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import {
  AdminTestWorkspaceRecordPage,
  type AdminTestWorkspaceMember,
  type AdminTestWorkspaceRecord,
} from "@/components/portal/admin-test-workspace-record-page";

type CreateMode = { kind: "workspace" } | { kind: "member"; workspaceId: string } | null;

const PRIVATE_FETCH: RequestInit = { cache: "no-store", credentials: "same-origin" };

async function fetchTestWorkspaces(): Promise<AdminTestWorkspaceRecord[]> {
  const response = await fetch("/api/admin/test-workspaces", PRIVATE_FETCH);
  const body = await response.json().catch(() => ({})) as { workspaces?: AdminTestWorkspaceRecord[]; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not load test workspaces.");
  return Array.isArray(body.workspaces) ? body.workspaces : [];
}

export function AdminTestWorkspacesClient({ detailId }: { detailId?: string } = {}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const [workspaces, setWorkspaces] = useState<AdminTestWorkspaceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviteRoles, setInviteRoles] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");

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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workspaces;
    return workspaces.filter((workspace) => workspace.name.toLowerCase().includes(needle));
  }, [workspaces, query]);

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

  async function setMemberState(member: AdminTestWorkspaceMember) {
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

  const inviteFormFor = (workspaceId: string) =>
    createMode?.kind === "member" && createMode.workspaceId === workspaceId ? (
      <form
        className="grid gap-3 rounded-2xl border border-border bg-card p-4 md:grid-cols-2"
        action={(form) => void inviteMember(workspaceId, form)}
        aria-busy={busyId === `invite:${workspaceId}`}
      >
        <label className="grid gap-1 text-xs font-semibold text-foreground" htmlFor={`test-name-${workspaceId}`}>
          Full name
          <input id={`test-name-${workspaceId}`} name="fullName" required autoComplete="name" className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-foreground" htmlFor={`test-email-${workspaceId}`}>
          Controlled email
          <input id={`test-email-${workspaceId}`} name="email" type="email" required autoComplete="email" spellCheck={false} className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40" />
        </label>
        <div className="grid gap-1">
          <PortalFormSingleSelect
            label="Portal role"
            value={inviteRoles[workspaceId] ?? "resident"}
            onChange={(role) => setInviteRoles((current) => ({ ...current, [workspaceId]: role }))}
            options={[
              { value: "resident", label: "Resident" },
              { value: "manager", label: "Manager" },
              { value: "co_manager", label: "Co-manager" },
            ]}
            dataAttr="test-workspace-member-role"
            labelClassName="block text-xs font-semibold text-foreground"
          />
          <input type="hidden" name="role" value={inviteRoles[workspaceId] ?? "resident"} />
        </div>
        <label className="grid gap-1 text-xs font-semibold text-foreground" htmlFor={`test-expiry-${workspaceId}`}>
          Expiry (optional)
          <input id={`test-expiry-${workspaceId}`} name="expiresAt" type="datetime-local" className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40" />
        </label>
        <div className="flex gap-2 md:col-span-2">
          <Button type="submit" disabled={busyId !== null}>{busyId ? "Sending…" : "Send private invite"}</Button>
          <Button type="button" variant="outline" onClick={() => setCreateMode(null)} disabled={busyId !== null}>Cancel</Button>
        </div>
      </form>
    ) : null;

  if (detailId) {
    const workspace = workspaces.find((w) => w.id === detailId);
    if (loading) {
      return (
        <ManagerPortalPageShell title="Test accounts" hideTitleOnMobileNav>
          <PortalDataTableEmpty icon="data" message="Loading…" />
        </ManagerPortalPageShell>
      );
    }
    if (!workspace) {
      return (
        <ManagerPortalPageShell title="Test accounts" hideTitleOnMobileNav>
          <PortalDataTableEmpty icon="data" message="Workspace not found" />
        </ManagerPortalPageShell>
      );
    }
    return (
      <AdminTestWorkspaceRecordPage
        workspace={workspace}
        backHref="/admin/test-accounts"
        busyId={busyId}
        onInviteMember={() => setCreateMode({ kind: "member", workspaceId: workspace.id })}
        onToggleMember={(member) => void setMemberState(member)}
        inviteForm={inviteFormFor(workspace.id)}
      />
    );
  }

  return (
    <ManagerPortalPageShell
      title="Test accounts"
      subtitle="Private workspaces for trusted operators to exercise the deployed portals without reaching customer data or providers."
      count={memberCount}
      hideTitleOnMobileNav
    >
      {/* Matches every manager list page's command header — search, a settings gear
          into the shared Settings screen, and the round + that replaces the old
          labelled "Create workspace" primary (mock: "search and a settings gear
          are back alongside the round +"). */}
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinations={[]}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search workspaces",
          dataAttr: "admin-test-workspaces-search",
          ariaLabel: "Search test workspaces",
        }}
        actions={
          <>
            <PortalIconAction
              icon={Settings}
              label="Test account settings"
              data-attr="admin-test-workspaces-settings"
              onClick={() => navigate("/admin/profile")}
            />
            <PortalPrimaryIconAction
              label="Create workspace"
              data-attr="test-workspace-create"
              onClick={() => setCreateMode({ kind: "workspace" })}
            />
          </>
        }
      />

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
          isEmpty={visible.length === 0}
          empty={<PortalDataTableEmpty icon="data" message={query.trim() ? "No workspaces match your search." : "No private test workspaces yet"} />}
          dataAttr="admin-test-workspace-list"
        >
          {visible.map((workspace) => {
            const activeMembers = workspace.members.filter((member) => member.state === "active").length;
            return (
              <PortalPersonRecordRow
                key={workspace.id}
                name={workspace.name}
                subtitle={`${activeMembers} active of ${workspace.members.length} accounts`}
                preview="Dedicated test data and captured external effects"
                meta={workspace.status === "active" ? "Active" : "Suspended"}
                onOpen={() => navigate(`/admin/test-accounts/${encodeURIComponent(workspace.id)}`)}
                dataAttr="admin-test-workspace-row"
                trailing={<ShieldCheck className="h-5 w-5 text-primary" aria-hidden />}
              />
            );
          })}
        </PortalRecordListSurface>
      )}
    </ManagerPortalPageShell>
  );
}
