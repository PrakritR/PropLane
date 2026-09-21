"use client";

/**
 * Promotes a team member to main manager of one or more houses in a
 * workspace the viewer owns. Opened from the member's ⋯ menu
 * (`pro-team-blocks.tsx`) and from the teams detail page footer.
 *
 * One POST per selected house
 * (`/api/pro/properties/[id]/transfer-ownership`), issued in order and
 * stopped at the first failure so a partial transfer is reported honestly
 * rather than silently retried or rolled back.
 */

import { useEffect, useMemo, useState } from "react";
import { Home, ShieldCheck, Users, Wallet } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { CoManagerPermissionsEditor } from "@/components/portal/workspace-permissions-fields";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";
import { EMPTY_CO_MANAGER_PERMISSIONS, type CoManagerPermissions } from "@/lib/co-manager-permissions";
import type { PortalWorkspace, WorkspaceMember } from "@/lib/workspaces/types";

type AfterRoleId = "admin" | "property_manager" | "viewer" | "custom" | "nothing";

const ROLE_AFTER_OPTIONS: { value: AfterRoleId; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "property_manager", label: "Property manager" },
  { value: "viewer", label: "Viewer" },
  { value: "custom", label: "Custom" },
  { value: "nothing", label: "Nothing" },
];

function firstNameOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function TransferOwnershipDialog({
  open,
  onClose,
  workspace,
  member,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  workspace: PortalWorkspace;
  member: WorkspaceMember;
  onDone: () => void;
}) {
  const { showToast } = useAppUi();
  const [scope, setScope] = useState<"all" | "selected">(member.houseScope === "all" ? "all" : "selected");
  const [selectedHouseIds, setSelectedHouseIds] = useState<string[]>(member.propertyIds ?? []);
  const [role, setRole] = useState<AfterRoleId>("admin");
  const [customPermissions, setCustomPermissions] = useState<CoManagerPermissions>(EMPTY_CO_MANAGER_PERMISSIONS);
  const [confirmText, setConfirmText] = useState("");

  // Reset every field whenever the dialog opens (including reopening on a
  // different member), so a stale pick from a previous transfer never rides
  // along into this one.
  useEffect(() => {
    if (!open) return;
    setScope(member.houseScope === "all" ? "all" : "selected");
    setSelectedHouseIds(member.propertyIds ?? []);
    setRole("admin");
    setCustomPermissions(EMPTY_CO_MANAGER_PERMISSIONS);
    setConfirmText("");
    // member/workspace are looked up fresh on every open; keying off their
    // ids (not object identity) avoids resetting on an unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, member.userId, workspace.id]);

  const houseLabel = (id: string) => workspace.propertyLabels?.[id]?.trim() || id;
  const houseIds = scope === "all" ? workspace.propertyIds : selectedHouseIds;
  const count = houseIds.length;
  const firstName = firstNameOf(member.name);

  const formerOwnerPermissions: CoManagerPermissions = useMemo(() => {
    if (role === "nothing") return EMPTY_CO_MANAGER_PERMISSIONS;
    if (role === "custom") return customPermissions;
    return stampTeamRolePermissions(role) ?? EMPTY_CO_MANAGER_PERMISSIONS;
  }, [role, customPermissions]);

  const confirmed = confirmText.trim().toLowerCase() === workspace.name.trim().toLowerCase();

  const submit = async () => {
    if (!confirmed || houseIds.length === 0) return;
    let done = 0;
    // Read WHY the first failing house didn't move (plan limit, ownership,
    // locked listing) so the toast names the reason instead of just the
    // house — the response body already carries it.
    let failureReason: string | null = null;
    for (const id of houseIds) {
      try {
        const res = await fetch(`/api/pro/properties/${encodeURIComponent(id)}/transfer-ownership`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newManagerUserId: member.userId, formerOwnerPermissions }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          failureReason = data.error?.trim() || null;
          break;
        }
        done += 1;
      } catch {
        break;
      }
    }
    const total = houseIds.length;
    if (done === total) {
      showToast(`${total} house${total === 1 ? "" : "s"} transferred to ${member.name}.`);
    } else {
      const notMoved = houseIds.slice(done).map((id) => houseLabel(id));
      showToast(
        `${done} of ${total} transferred. Not moved: ${notMoved.join(", ")}.${failureReason ? ` ${failureReason}` : ""}`,
      );
    }
    onDone();
  };

  return (
    <Modal
      open={open}
      title={`Transfer ownership to ${member.name}`}
      onClose={onClose}
      panelClassName="max-w-lg"
      dataAttr="transfer-ownership-dialog"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="danger"
            disabled={!confirmed || houseIds.length === 0}
            onClick={() => submit()}
            data-attr="transfer-submit"
          >
            Transfer ownership
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <FieldSingleSelect
          label="Houses"
          value={scope}
          onChange={(next) => setScope(next as "all" | "selected")}
          options={[
            { value: "all", label: `All houses in ${workspace.name} (${workspace.propertyIds.length})` },
            { value: "selected", label: "Only selected houses" },
          ]}
          dataAttr="transfer-houses"
        />
        {scope === "selected" ? (
          <CheckboxMultiSelect
            label="Selected houses"
            options={workspace.propertyIds.map((id) => ({ value: id, label: houseLabel(id) }))}
            selected={selectedHouseIds}
            onChange={setSelectedHouseIds}
            emptyLabel="Select houses…"
            searchPlaceholder="Search houses…"
            dataAttr="transfer-selected-houses"
          />
        ) : null}

        <ul className="space-y-2.5" data-attr="transfer-consequences">
          <li className="flex items-start gap-2.5 text-sm text-foreground">
            <Home className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span>
              {count} house{count === 1 ? "" : "s"} move to {firstName}&apos;s account and leave {workspace.name}.
            </span>
          </li>
          <li className="flex items-start gap-2.5 text-sm text-foreground">
            <Wallet className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span>Rent and fees for them pay out to {firstName}&apos;s bank account from the next charge.</span>
          </li>
          <li className="flex items-start gap-2.5 text-sm text-foreground">
            <Users className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span>
              {firstName} decides who works on them. Members of {workspace.name} lose these houses unless {firstName}{" "}
              invites them.
            </span>
          </li>
          <li className="flex items-start gap-2.5 text-sm text-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span className="flex flex-wrap items-center gap-1.5">
              You stay on them as
              <FieldSingleSelect
                label="Your role afterwards"
                hideLabel
                variant="pill"
                value={role}
                onChange={(next) => setRole(next as AfterRoleId)}
                options={ROLE_AFTER_OPTIONS}
                dataAttr="transfer-keep-role"
              />
            </span>
          </li>
        </ul>

        {role === "custom" ? (
          <CoManagerPermissionsEditor hideRole value={customPermissions} onChange={setCustomPermissions} />
        ) : null}

        <label className="block">
          <span className="text-xs font-semibold text-muted">Type {workspace.name} to confirm</span>
          <Input className="mt-1" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} data-attr="transfer-confirm" />
        </label>
      </div>
    </Modal>
  );
}
