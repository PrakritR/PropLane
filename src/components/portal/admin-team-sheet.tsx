"use client";

/**
 * Invite to PropLane admin, and Change role on someone already on the admin team.
 *
 * The role dropdown is the manager Team invite's (TEAM_ROLE_INVITE_OPTIONS) with Overall admin added; Workspaces is a
 * multi-select of the service workspaces the viewer manages; Houses and the per-module access grid are the same controls
 * the service Invite sheet uses. Overall admin locks the grid to everything and hides Workspaces. The server re-derives
 * every part of the request; opening the sheet changes nothing.
 */
import { useMemo, useState } from "react";
import { ConfirmRows } from "@/components/portal/portal-dialog";
import { CoManagerPermissionsEditor, WorkspaceGrantFields } from "@/components/portal/workspace-permissions-fields";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { EMPTY_CO_MANAGER_PERMISSIONS, type CoManagerPermissions } from "@/lib/co-manager-permissions";
import { stampTeamRolePermissions, type TeamRoleId } from "@/lib/co-manager-team-roles";
import { DEFAULT_NEW_INVITE_WORKSPACE_GRANT, type WorkspaceCoManagerGrant } from "@/lib/workspace-co-manager-permissions";
import {
  ADMIN_TEAM_ROLE_OPTIONS,
  OVERALL_ADMIN_ROLE,
  adminTeamChangeRequest,
  adminTeamInviteRequest,
  adminTeamRoleLabel,
  type AdminTeamMemberRow,
  type AdminTeamRole,
  type AdminTeamWorkspace,
} from "@/lib/admin-team/admin-team-model";
import { houseScopeForRoleChange, type HouseScope } from "@/lib/workspaces/membership";

const ALL_MODULES_MANAGE: CoManagerPermissions = stampTeamRolePermissions("admin") ?? EMPTY_CO_MANAGER_PERMISSIONS;

export function AdminTeamSheet({
  workspaces,
  member,
  onClose,
  onChanged,
}: {
  /** The service workspaces the viewer manages (with their houses). */
  workspaces: AdminTeamWorkspace[];
  /** Present: Change role for this person. Absent: a new invite. */
  member: AdminTeamMemberRow | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { showToast } = useAppUi();
  const editing = member !== null && member.userId !== null;
  const [email, setEmail] = useState(member?.email ?? "");
  const [role, setRole] = useState<AdminTeamRole>(member?.role ?? "viewer");
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(() => member?.seats.map((s) => s.workspaceId) ?? workspaces.slice(0, 1).map((w) => w.id));
  const firstSeat = member?.seats[0];
  const [houseScope, setHouseScope] = useState<HouseScope>(firstSeat?.houseScope ?? "all");
  const [houseIds, setHouseIds] = useState<string[]>(firstSeat?.houseScope === "selected" ? firstSeat.assignedPropertyIds : []);
  const [customPermissions, setCustomPermissions] = useState<CoManagerPermissions>(EMPTY_CO_MANAGER_PERMISSIONS);
  const [workspacePermissions, setWorkspacePermissions] = useState<WorkspaceCoManagerGrant>(DEFAULT_NEW_INVITE_WORKSPACE_GRANT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOverall = role === OVERALL_ADMIN_ROLE;
  const single = workspaceIds.length === 1 ? workspaces.find((w) => w.id === workspaceIds[0]) : undefined;
  const effectiveScope: HouseScope = single ? houseScope : "all";
  const effective = isOverall ? ALL_MODULES_MANAGE : role === "custom" ? customPermissions : (stampTeamRolePermissions(role as TeamRoleId) ?? EMPTY_CO_MANAGER_PERMISSIONS);
  const workspaceOptions = useMemo(() => workspaces.map((w) => ({ value: w.id, label: w.city ? `${w.name} · ${w.city}` : w.name })), [workspaces]);
  const houseOptions = useMemo(() => (single?.houses ?? []).map((h) => ({ value: h.id, label: h.label })), [single]);

  const changeRole = (next: AdminTeamRole) => {
    setRole(next);
    if (next !== OVERALL_ADMIN_ROLE) {
      const scoped = houseScopeForRoleChange(next as TeamRoleId, { houseScope, selectedHouseIds: houseIds });
      setHouseScope(scoped.houseScope);
      setHouseIds(scoped.selectedHouseIds);
    }
  };

  const choice = { role, workspaceIds, houseScope: effectiveScope, houseIds, customPermissions, workspacePermissions: workspacePermissions as Record<string, unknown> };
  const needsWorkspace = !isOverall && workspaceIds.length === 0;
  const needsHouse = !isOverall && effectiveScope === "selected" && houseIds.length === 0;
  const canSend = (editing || email.trim().includes("@")) && !needsWorkspace && !needsHouse && !busy;

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const body = editing
        ? adminTeamChangeRequest({ userId: member!.userId!, choice })
        : adminTeamInviteRequest({ email, choice });
      const res = await fetchWithTimeout(
        editing ? "/api/admin/team/change" : "/api/admin/team/invite",
        { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        25_000,
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? "That did not work. Please retry.");
        return;
      }
      showToast(editing ? "Role saved." : "Invite sent.");
      await onChanged();
      onClose();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={editing ? `Change role · ${member!.name}` : "Invite to PropLane admin"}
      onClose={onClose}
      panelClassName="max-w-2xl"
      dataAttr="admin-team-sheet"
      previewLabel="Invite preview"
      preview={
        <ConfirmRows
          rows={[
            { label: "Role", value: adminTeamRoleLabel(role) },
            { label: "Workspaces", value: isOverall ? "All" : workspaceIds.map((id) => workspaces.find((w) => w.id === id)?.name ?? "").filter(Boolean).join(", ") || "None" },
            { label: "Houses", value: isOverall ? "All" : effectiveScope === "all" ? "All houses" : `${houseIds.length} selected` },
            { label: "Recipient", value: (editing ? member!.email : email.trim()) || "Not set" },
          ]}
        />
      }
      footer={
        <ModalFooter className="justify-end">
          <Button type="button" variant="outline" className="rounded-full" onClick={onClose} data-attr="admin-team-cancel">
            Cancel
          </Button>
          <Button type="button" variant="primary" className="rounded-full" disabled={!canSend} onClick={() => submit()} data-attr="admin-team-send">
            {editing ? "Save role" : "Send invite"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <Input
          aria-label="Email"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
          disabled={editing}
          maxLength={254}
          autoComplete="off"
          data-attr="admin-team-email"
        />
        <FieldSingleSelect
          label="Role"
          options={ADMIN_TEAM_ROLE_OPTIONS}
          value={role === "full" ? "admin" : role}
          onChange={(next) => changeRole(next as AdminTeamRole)}
          dataAttr="admin-team-role"
        />
        {isOverall ? null : (
          <>
            <CheckboxMultiSelect
              label="Workspaces"
              labelClassName="text-xs font-semibold text-foreground"
              options={workspaceOptions}
              selected={workspaceIds}
              onChange={setWorkspaceIds}
              emptyLabel="Select workspaces…"
              searchPlaceholder="Search workspaces…"
              dataAttr="admin-team-workspaces"
            />
            {single ? (
              <FieldSingleSelect
                label="Houses"
                options={[
                  { value: "all", label: `All houses in ${single.name} (${single.houses.length})` },
                  { value: "selected", label: "Only selected houses" },
                ]}
                value={houseScope}
                onChange={(next) => setHouseScope(next === "all" ? "all" : "selected")}
                dataAttr="admin-team-houses"
              />
            ) : null}
            {single && houseScope === "selected" ? (
              <CheckboxMultiSelect
                label="Selected houses"
                labelClassName="text-xs font-semibold text-foreground"
                options={houseOptions}
                selected={houseIds}
                onChange={setHouseIds}
                emptyLabel="Select houses…"
                searchPlaceholder="Search houses…"
                dataAttr="admin-team-selected-houses"
              />
            ) : null}
          </>
        )}
        <CoManagerPermissionsEditor
          hideRole
          hidePresets
          disabled={isOverall}
          role={isOverall ? "admin" : (role as TeamRoleId)}
          onRoleChange={(next) => setRole(next)}
          value={effective}
          onChange={setCustomPermissions}
        />
        {role === "custom" ? <WorkspaceGrantFields value={workspacePermissions} onChange={setWorkspacePermissions} /> : null}
        {error ? (
          <p role="alert" className="text-sm font-semibold text-danger" data-attr="admin-team-error">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
