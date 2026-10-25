"use client";

/**
 * Invite to a PropLane Service workspace, and Edit access on a seat that is already on its team.
 *
 * The same pieces the manager Invite sheet uses (`WorkspacePermissionsFields` for Role and Houses,
 * `CoManagerPermissionsEditor` for the per-module levels, `WorkspaceGrantFields` for a Custom role's workspace
 * rights), with a different send: a service seat is written by the admin Service route (`team-invite` /
 * `team-access`), which re-derives the role, the houses and the levels server-side. Role includes "Owner" (the
 * client's owner of record: read-only by role, no houses to pick, one per workspace; sending a second asks to replace).
 *
 * Opening the sheet changes nothing; the primary button is the only write.
 */
import { useMemo, useState } from "react";
import { ConfirmRows } from "@/components/portal/portal-dialog";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import {
  CoManagerPermissionsEditor,
  RoleCapabilitiesList,
  WorkspaceGrantFields,
  WorkspacePermissionsFields,
} from "@/components/portal/workspace-permissions-fields";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { TEAM_ROLE_LABELS, parseTeamRole, stampTeamRolePermissions, type TeamRoleId } from "@/lib/co-manager-team-roles";
import {
  EMPTY_CO_MANAGER_PERMISSIONS,
  flatCoManagerPermissionsFromProperty,
  normalizePropertyCoManagerPermissions,
  type CoManagerPermissions,
} from "@/lib/co-manager-permissions";
import { DEFAULT_NEW_INVITE_WORKSPACE_GRANT, normalizeWorkspacePermissions, type WorkspaceCoManagerGrant } from "@/lib/workspace-co-manager-permissions";
import { houseScopeForRoleChange, memberReachLabel, type HouseScope } from "@/lib/workspaces/membership";
import { effectiveServicePermissions, serviceAccessRequest, serviceInviteRequest } from "@/lib/service/service-team-invite";
import type { ServiceTeamMember } from "@/lib/service/service-team-types";
import type { PortalWorkspace } from "@/lib/workspaces/types";

const API = "/api/admin/service-workspaces";

type SheetWorkspace = Pick<PortalWorkspace, "id" | "name" | "propertyIds" | "propertyLabels">;

function roleLabelFor(role: TeamRoleId): string {
  return role === "property_owner" ? "Owner" : TEAM_ROLE_LABELS[role === "full" ? "admin" : role];
}

/** The state Edit access starts from: what the seat stores today, read back through the same normalisers. */
export function accessStateFromMember(member: ServiceTeamMember, workspace: SheetWorkspace) {
  const parsed = parseTeamRole(member.role);
  const role: TeamRoleId = (parsed.ok ? parsed.role : null) ?? "custom";
  const houseScope: HouseScope = member.houseScope === "selected" ? "selected" : "all";
  const assigned = member.assignedPropertyIds ?? [];
  const inWorkspace = new Set(workspace.propertyIds);
  return {
    role,
    houseScope,
    selectedHouseIds: houseScope === "selected" ? assigned.filter((id) => inWorkspace.has(id)) : [],
    customPermissions:
      role === "custom"
        ? flatCoManagerPermissionsFromProperty(normalizePropertyCoManagerPermissions(member.propertyCoManagerPermissions ?? {}, assigned))
        : EMPTY_CO_MANAGER_PERMISSIONS,
    workspacePermissions: role === "custom" ? normalizeWorkspacePermissions(member.workspacePermissions) : DEFAULT_NEW_INVITE_WORKSPACE_GRANT,
  };
}

export function ServiceInviteSheet({
  open,
  workspace,
  member,
  onClose,
  onChanged,
}: {
  open: boolean;
  workspace: SheetWorkspace;
  /** Present: Edit access for this seat. Absent: a new invite. */
  member: ServiceTeamMember | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const editing = member !== null;

  // The caller mounts a fresh sheet (keyed on the seat) for every open, so the starting state is read once: what the
  // seat stores today when editing, else a Viewer on every house.
  const [start] = useState(() => (member ? accessStateFromMember(member, workspace) : null));
  const [recipient, setRecipient] = useState(() => (member ? member.email || member.name : ""));
  const [role, setRole] = useState<TeamRoleId>(start?.role ?? "viewer");
  const [houseScope, setHouseScope] = useState<HouseScope>(start?.houseScope ?? "all");
  const [selectedHouseIds, setSelectedHouseIds] = useState<string[]>(start?.selectedHouseIds ?? []);
  const [customPermissions, setCustomPermissions] = useState<CoManagerPermissions>(start?.customPermissions ?? EMPTY_CO_MANAGER_PERMISSIONS);
  const [workspacePermissions, setWorkspacePermissions] = useState<WorkspaceCoManagerGrant>(
    start?.workspacePermissions ?? DEFAULT_NEW_INVITE_WORKSPACE_GRANT,
  );
  const [error, setError] = useState<string | null>(null);

  const isOwner = role === "property_owner";
  const houseIds = useMemo(() => (houseScope === "all" ? workspace.propertyIds : selectedHouseIds), [houseScope, selectedHouseIds, workspace.propertyIds]);
  const houseOptions = useMemo(
    () => workspace.propertyIds.map((id) => ({ value: id, label: workspace.propertyLabels?.[id]?.trim() || id })),
    [workspace.propertyIds, workspace.propertyLabels],
  );
  const effective = effectiveServicePermissions({ role, customPermissions });
  const reach = isOwner
    ? "Every house, view only"
    : houseScope === "all"
      ? `All houses in ${workspace.name}`
      : memberReachLabel({ houseScope: "selected", houseCount: selectedHouseIds.length, workspaceHouseCount: workspace.propertyIds.length });

  const changeRole = (next: TeamRoleId) => {
    setRole(next);
    const scoped = houseScopeForRoleChange(next, { houseScope, selectedHouseIds });
    setHouseScope(scoped.houseScope);
    setSelectedHouseIds(scoped.selectedHouseIds);
  };

  const choice = { role, houseScope, houseIds, customPermissions, workspacePermissions };
  const recipientOk = editing || recipient.trim().length > 0;
  const needsHouse = !isOwner && houseScope === "selected" && selectedHouseIds.length === 0;
  const canSend = recipientOk && !needsHouse;

  const post = async (body: Record<string, unknown>): Promise<{ ok: boolean; status: number; error?: string; code?: string; ownerName?: string }> => {
    try {
      const res = await fetchWithTimeout(
        API,
        { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        25_000,
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string; ownerName?: string; delivery?: string };
      return { ok: res.ok, status: res.status, ...json };
    } catch {
      return { ok: false, status: 0, error: "Could not reach the server. Try again." };
    }
  };

  const submit = async () => {
    if (!canSend) return;
    setError(null);
    if (editing) {
      const result = await post(serviceAccessRequest({ workspaceId: workspace.id, linkId: member.linkId, choice }));
      if (!result.ok) {
        setError(result.error ?? "That did not work. Please retry.");
        return;
      }
      showToast("Access saved.");
      await onChanged();
      onClose();
      return;
    }
    let replaceOwner = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = serviceInviteRequest({ workspaceId: workspace.id, recipient, choice, replaceOwner });
      if (!body) return;
      const result = await post(body);
      if (result.ok) {
        showToast(isOwner ? "Owner invite sent." : "Invite sent.");
        await onChanged();
        onClose();
        return;
      }
      // One owner per workspace: ask before replacing, and say who is replaced.
      if (result.code === "owner_exists" && !replaceOwner) {
        const replace = await confirm({
          title: "Replace the owner?",
          description: `${result.ownerName ?? "The current owner"} is the owner now. Sending this invite replaces them.`,
          confirmLabel: "Replace",
        });
        if (!replace) return;
        replaceOwner = true;
        continue;
      }
      setError(result.error ?? "That did not work. Please retry.");
      return;
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? `Edit access · ${member.name}` : `Invite to ${workspace.name}`}
      onClose={onClose}
      panelClassName="max-w-2xl"
      dataAttr="service-invite-sheet"
      contextPanel={<div className="rounded-xl border border-border bg-card p-4 text-sm font-semibold">{workspace.name}</div>}
      previewLabel="Invite preview"
      preview={
        <ConfirmRows
          rows={[
            { label: "Workspace", value: workspace.name },
            { label: "Role", value: roleLabelFor(role) },
            { label: "Houses", value: reach },
            { label: "Recipient", value: recipient.trim() || "Not set" },
          ]}
        />
      }
      footer={
        <ModalFooter className="justify-end">
          <Button type="button" variant="outline" className="rounded-full" onClick={onClose} data-attr="service-invite-cancel">
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            disabled={!canSend}
            onClick={() => submit()}
            data-attr="service-invite-send"
          >
            {editing ? "Save access" : "Send invite"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <Input
          aria-label="Email or PropLane ID"
          placeholder="Email or PropLane ID"
          value={recipient}
          onChange={(event) => {
            setRecipient(event.target.value);
            setError(null);
          }}
          disabled={editing}
          maxLength={120}
          autoComplete="off"
          data-attr="service-invite-recipient"
        />

        <WorkspacePermissionsFields
          ownerOption
          hideHouses={isOwner}
          role={role}
          onRoleChange={changeRole}
          houseScope={houseScope}
          onHouseScopeChange={setHouseScope}
          selectedHouseIds={selectedHouseIds}
          onSelectedHouseIdsChange={setSelectedHouseIds}
          workspace={{ name: workspace.name, houseCount: workspace.propertyIds.length }}
          houseOptions={houseOptions}
          roleDataAttr="service-invite-role"
          houseScopeDataAttr="service-invite-houses"
          selectedHousesDataAttr="service-invite-selected-houses"
        />

        {isOwner ? (
          <RoleCapabilitiesList role="property_owner" grant={stampTeamRolePermissions("property_owner") ?? EMPTY_CO_MANAGER_PERMISSIONS} />
        ) : (
          <>
            <CoManagerPermissionsEditor
              hideRole
              hidePresets
              role={role}
              onRoleChange={setRole}
              value={effective}
              onChange={setCustomPermissions}
            />
            {role === "custom" ? <WorkspaceGrantFields value={workspacePermissions} onChange={setWorkspacePermissions} /> : null}
          </>
        )}

        {error ? (
          <p role="alert" className="text-sm font-semibold text-danger" data-attr="service-invite-error">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
