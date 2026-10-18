"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, Home, Phone, Users } from "lucide-react";
import { PortalListGroup } from "@/components/portal/portal-list-group";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { AdminNewServiceWorkspace } from "@/components/portal/admin-new-service-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { cleanOwnerOfRecord, cleanServiceCity, cleanServiceName } from "@/lib/service/service-input";
import { serviceWorkspaceFinancesHref } from "@/lib/service/service-links";
import { Trash2 } from "lucide-react";

const FETCH_TIMEOUT_MS = 25_000;
const API = "/api/admin/service-workspaces";

export type ServiceRow = {
  id: string;
  name: string;
  city: string | null;
  ownerOfRecord: { name: string; linked: boolean } | null;
  isDefault: boolean;
  houseCount: number;
  workNumber: string | null;
  workNumberSource: "own" | "shared" | null;
  teamCount: number;
  viewerRole: string | null;
  canManage: boolean;
};

type TeamState = {
  members: {
    linkId: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    status: "accepted" | "pending";
    ownerOfRecord: boolean;
  }[];
  candidates: { userId: string; name: string; email: string }[];
  canManage: boolean;
};

type State =
  | { status: "loading" }
  | { status: "ready"; configured: boolean; rows: ServiceRow[] }
  | { status: "error"; message: string };

/** The glyph facts on a service workspace row: houses, work number, team. */
export function serviceRowFacts(row: ServiceRow): PortalEntryRowFact[] {
  const facts: PortalEntryRowFact[] = [
    { icon: Home, label: `${row.houseCount} ${row.houseCount === 1 ? "house" : "houses"}`, srLabel: "Houses" },
    { icon: Phone, label: row.workNumber ?? "No number", srLabel: "Work number" },
    { icon: Users, label: row.viewerRole ? `${row.teamCount} on team` : "Not on team", srLabel: "Team" },
  ];
  return facts;
}

/** Service workspaces grouped per city: Seattle first, the rest alphabetical, workspaces with no city last. */
export function groupServiceByCity(rows: ServiceRow[]): { city: string | null; rows: ServiceRow[] }[] {
  // One group per city, matched ignoring case and spacing; the first spelling seen is the heading.
  const map = new Map<string, { city: string; rows: ServiceRow[] }>();
  for (const row of rows) {
    const display = row.city?.trim().replace(/\s+/g, " ") ?? "";
    const key = display.toLowerCase();
    const group = map.get(key);
    if (group) group.rows.push(row);
    else map.set(key, { city: display, rows: [row] });
  }
  const rank = (key: string) => (!key ? 2 : key === "seattle" ? 0 : 1);
  return [...map.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([, group]) => ({ city: group.city || null, rows: group.rows }));
}

async function post<T extends Record<string, unknown>>(body: Record<string, unknown>): Promise<{ ok: boolean; json: T & { error?: string }; res: Response }> {
  const res = await fetchWithTimeout(API, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, FETCH_TIMEOUT_MS);
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, json, res };
}

/**
 * Admin > Accounts > Service: PropLane's own managed-property workspaces (one per city), owned by the
 * service owner account. A row is name - city - houses - work number; the per-row menu opens the workspace in
 * the property portal, renames it, manages its team and sets up its own work number.
 */
export function AdminServicePanel() {
  const { showToast } = useAppUi();
  const [state, setState] = useState<State>({ status: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [cityDraft, setCityDraft] = useState("");
  const [clientDraft, setClientDraft] = useState("");
  const [inviteId, setInviteId] = useState("");
  const [inviteOwner, setInviteOwner] = useState(false);
  const [team, setTeam] = useState<TeamState | null>(null);
  const [candidateId, setCandidateId] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout(API, { credentials: "include" }, FETCH_TIMEOUT_MS);
        const json = (await res.json().catch(() => ({}))) as { configured?: boolean; workspaces?: ServiceRow[]; error?: string };
        if (cancelled) return;
        if (!res.ok || !json.workspaces) {
          setState({ status: "error", message: "Could not load service workspaces." });
          return;
        }
        setState({ status: "ready", configured: json.configured !== false, rows: json.workspaces });
      } catch (error) {
        if (cancelled) return;
        setState({ status: "error", message: error instanceof FetchTimeoutError ? "That took too long to load." : "Could not load service workspaces." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setReloadTick((n) => n + 1);
  }, []);

  const rows = useMemo(() => (state.status === "ready" ? state.rows : []), [state]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const open = async (row: ServiceRow) => {
    setBusy(true);
    try {
      const { ok, json } = await post<{ href?: string }>({ action: "open", id: row.id });
      if (!ok || !json.href) {
        showToast(json.error ?? "Could not open this workspace.");
        return;
      }
      // Land in the property portal itself: a multi-role account would otherwise stop at the portal chooser.
      // Best effort and re-checked server-side (reachability); the workspace cookie is already set.
      await fetchWithTimeout("/api/auth/set-active-portal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "manager" }),
      }, FETCH_TIMEOUT_MS).catch(() => undefined);
      // A full navigation: the property portal reads the workspace cookie the route just set.
      window.location.assign(json.href);
    } catch {
      showToast("Could not open this workspace.");
    } finally {
      setBusy(false);
    }
  };

  const loadTeam = useCallback(async (id: string) => {
    setTeam(null);
    setFormError(null);
    try {
      const { ok, json } = await post<Partial<TeamState>>({ action: "team", id });
      if (!ok) {
        setFormError(json.error ?? "Could not load the team.");
        return;
      }
      setTeam({ members: json.members ?? [], candidates: json.candidates ?? [], canManage: json.canManage === true });
    } catch {
      setFormError("Could not load the team.");
    }
  }, []);

  const invite = async () => {
    if (!selected || !inviteId.trim()) return;
    setBusy(true);
    setFormError(null);
    try {
      const { ok, json } = await post({ action: "team-invite", id: selected.id, proplaneId: inviteId.trim(), ownerOfRecord: inviteOwner });
      if (!ok) {
        setFormError(json.error ?? "Could not send the invite.");
        return;
      }
      setInviteId("");
      setInviteOwner(false);
      await loadTeam(selected.id);
      reload();
    } catch {
      setFormError("Could not send the invite.");
    } finally {
      setBusy(false);
    }
  };

  const setOwnerOfRecord = async (linkId: string, value: boolean) => {
    if (!selected) return;
    setBusy(true);
    setFormError(null);
    try {
      const { ok, json } = await post({ action: "team-owner-of-record", id: selected.id, linkId, value });
      if (!ok) {
        setFormError(json.error ?? "Could not update the owner of record.");
        return;
      }
      await loadTeam(selected.id);
      reload();
    } catch {
      setFormError("Could not update the owner of record.");
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async () => {
    if (!selected) return;
    setBusy(true);
    setFormError(null);
    try {
      const { ok, json } = await post({ action: "rename", id: selected.id, name: cleanServiceName(nameDraft), city: cleanServiceCity(cityDraft), ownerOfRecord: cleanOwnerOfRecord(clientDraft) });
      if (!ok) {
        setFormError(json.error ?? "Could not rename the workspace.");
        return;
      }
      setRenameOpen(false);
      reload();
    } catch {
      setFormError("Could not rename the workspace.");
    } finally {
      setBusy(false);
    }
  };

  const addMember = async () => {
    if (!selected || !candidateId) return;
    setBusy(true);
    setFormError(null);
    try {
      const { ok, json } = await post({ action: "team-add", id: selected.id, userId: candidateId });
      if (!ok) {
        setFormError(json.error ?? "Could not add the teammate.");
        return;
      }
      setCandidateId("");
      await loadTeam(selected.id);
      reload();
    } catch {
      setFormError("Could not add the teammate.");
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (linkId: string) => {
    if (!selected) return;
    setBusy(true);
    setFormError(null);
    try {
      const { ok, json } = await post({ action: "team-remove", id: selected.id, linkId });
      if (!ok) {
        setFormError(json.error ?? "Could not remove the teammate.");
        return;
      }
      await loadTeam(selected.id);
      reload();
    } catch {
      setFormError("Could not remove the teammate.");
    } finally {
      setBusy(false);
    }
  };

  const bulkActions = selected && selected.viewerRole ? (
    <>
      <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-service-open" disabled={busy} onClick={() => void open(selected)}>
        Open
      </Button>
      {selected.canManage ? (
        <>
          <Button
            type="button"
            variant="outline"
            className={PORTAL_BULK_BAR_BTN}
            data-attr="admin-service-rename"
            onClick={() => { setFormError(null); setNameDraft(selected.name); setCityDraft(selected.city ?? ""); setClientDraft(selected.ownerOfRecord?.linked ? "" : selected.ownerOfRecord?.name ?? ""); setRenameOpen(true); }}
          >
            Rename
          </Button>
          <Button
            type="button"
            variant="outline"
            className={PORTAL_BULK_BAR_BTN}
            data-attr="admin-service-team"
            onClick={() => { setCandidateId(""); setInviteId(""); setInviteOwner(false); setTeamOpen(true); void loadTeam(selected.id); }}
          >
            Team
          </Button>
          {serviceWorkspaceFinancesHref(selected.id) ? (
            <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-service-finances" onClick={() => window.location.assign(serviceWorkspaceFinancesHref(selected.id)!)}>
              Finances
            </Button>
          ) : null}
        </>
      ) : null}
    </>
  ) : null;

  const notConfigured = state.status === "ready" && !state.configured;

  return (
    <ManagerPortalPageShell title="Service" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinations={[]}
        activeDestinationId=""
        destinationAriaLabel="Service"
        primary={
          <PortalPrimaryIconAction
            label="Add workspace"
            data-attr="admin-service-add"
            disabled={notConfigured || state.status === "loading"}
            onClick={() => setAddOpen(true)}
          />
        }
      />
      <PortalRecordListSurface
        loading={state.status === "loading"}
        loadError={state.status === "error" ? state.message : undefined}
        onRetry={reload}
        isEmpty={rows.length === 0}
        empty={<PortalDataTableEmpty icon="data" message={notConfigured ? "The service owner is not set up" : "No service workspaces yet"} />}
        bulkCount={selected ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={() => setSelectedId(null)}
        dataAttr="admin-service-list"
      >
        {groupServiceByCity(rows).map((group) => (
          <PortalListGroup
            key={group.city ?? "none"}
            listKey="admin-service"
            groupKey={group.city ?? "none"}
            name={group.city ?? "No city"}
            count={`${group.rows.length} ${group.rows.length === 1 ? "workspace" : "workspaces"}`}
            dataAttr="admin-service-city"
          >
            {group.rows.map((row) => (
              <PortalEntryRow
                key={row.id}
                tile={{ kind: "glyph", icon: Building2, label: "Service workspace" }}
                title={row.name}
                place={row.ownerOfRecord?.name}
                facts={serviceRowFacts(row)}
                checked={selectedId === row.id}
                onSelectedChange={(on) => setSelectedId(on ? row.id : null)}
                onOpen={row.viewerRole ? () => void open(row) : undefined}
                omitActionView
                dataAttr="admin-service-row"
              />
            ))}
          </PortalListGroup>
        ))}
      </PortalRecordListSurface>

      <AdminNewServiceWorkspace
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(_id, name) => {
          setAddOpen(false);
          showToast(`${name} created.`);
          reload();
        }}
      />

      <Modal
        open={renameOpen}
        title="Rename workspace"
        onClose={() => setRenameOpen(false)}
        dataAttr="admin-service-rename-modal"
        footer={
          <ModalFooter>
            <Button type="button" disabled={busy || !cleanServiceName(nameDraft) || cleanServiceCity(cityDraft) === undefined || cleanOwnerOfRecord(clientDraft) === undefined} data-attr="admin-service-rename-save" onClick={() => void saveRename()}>
              Save
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Name</span>
            <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={80} data-attr="admin-service-rename-name" />
          </label>
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">City</span>
            <Input value={cityDraft} onChange={(e) => setCityDraft(e.target.value)} maxLength={80} data-attr="admin-service-rename-city" />
          </label>
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Owner of record</span>
            <Input value={clientDraft} onChange={(e) => setClientDraft(e.target.value)} maxLength={80} data-attr="admin-service-rename-client" />
          </label>
        </div>
        {formError ? <p className="mt-2 text-[13px] text-[var(--status-overdue-fg)]" role="alert">{formError}</p> : null}
      </Modal>

      <Modal open={teamOpen} title="Team" onClose={() => setTeamOpen(false)} dataAttr="admin-service-team-modal">
        {team ? (
          <div className="space-y-4">
            <ul className="divide-y divide-border" data-attr="admin-service-team-list">
              {team.members.length === 0 ? <li className="py-2 text-[14px] text-muted">No teammates yet</li> : null}
              {team.members.map((m) => (
                <li key={m.linkId} className="flex items-center justify-between gap-3 py-2" data-attr="admin-service-team-member">
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold text-foreground">
                      {m.name}
                      {m.status === "pending" ? " · Invited" : ""}
                    </span>
                    <span className="block truncate text-[12.5px] text-muted">{m.email || "Admin"}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {team.canManage ? (
                      <label className="flex items-center gap-1.5 text-[13px] text-foreground">
                        <input
                          type="checkbox"
                          checked={m.ownerOfRecord}
                          disabled={busy}
                          onChange={(e) => void setOwnerOfRecord(m.linkId, e.target.checked)}
                          data-attr="admin-service-team-owner-of-record"
                        />
                        Owner of record
                      </label>
                    ) : m.ownerOfRecord ? (
                      <span className="text-[13px] text-foreground">Owner of record</span>
                    ) : null}
                    {team.canManage ? (
                      <PortalIconAction icon={Trash2} label="Remove" ariaLabel={`Remove ${m.name}`} disabled={busy} data-attr="admin-service-team-remove" onClick={() => void removeMember(m.linkId)} />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {team.canManage ? (
              <div className="space-y-2" data-attr="admin-service-invite">
                <label className="block text-[13px] font-semibold text-foreground">
                  <span className="mb-1 block">Invite owner</span>
                  <span className="flex items-center gap-2">
                    <Input value={inviteId} onChange={(e) => setInviteId(e.target.value)} maxLength={40} placeholder="PropLane ID" data-attr="admin-service-invite-id" />
                    <Button type="button" disabled={busy || !inviteId.trim()} data-attr="admin-service-invite-send" onClick={() => void invite()}>
                      Invite
                    </Button>
                  </span>
                </label>
                <label className="flex items-center gap-1.5 text-[13px] text-foreground">
                  <input type="checkbox" checked={inviteOwner} onChange={(e) => setInviteOwner(e.target.checked)} data-attr="admin-service-invite-owner" />
                  Owner of record
                </label>
              </div>
            ) : null}
            {team.canManage ? (
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <FieldSingleSelect
                    label="Add an admin"
                    options={team.candidates.map((c) => ({ value: c.userId, label: c.name === c.email ? c.email : `${c.name} - ${c.email}` }))}
                    value={candidateId}
                    onChange={setCandidateId}
                    placeholder="Choose an admin"
                    searchPlaceholder="Search admins"
                    dataAttr="admin-service-team-candidate"
                  />
                </div>
                <Button type="button" disabled={busy || !candidateId} data-attr="admin-service-team-add" onClick={() => void addMember()}>
                  Add
                </Button>
              </div>
            ) : null}
            {selected ? (
              <Button type="button" variant="outline" data-attr="admin-service-team-invite-by-role" onClick={() => void open(selected)}>
                Invite by role in the portal
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="py-6 text-center text-[14px] text-muted" role="status">Loading</p>
        )}
        {formError ? <p className="mt-2 text-[13px] text-[var(--status-overdue-fg)]" role="alert">{formError}</p> : null}
      </Modal>

    </ManagerPortalPageShell>
  );
}
