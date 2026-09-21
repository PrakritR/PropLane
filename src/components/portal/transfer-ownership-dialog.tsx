"use client";

/**
 * Hands the whole workspace to an accepted member. There is no per-house
 * picking any more — a workspace has exactly one owner
 * (`portal_workspaces.owner_user_id`), and every house in it belongs to that
 * owner. Opened from the member's ⋯ menu (`pro-team-blocks.tsx`) and from the
 * teams detail page footer (`pro-account-links-panel.tsx`).
 *
 * One POST to `/api/pro/workspaces/[workspaceId]/transfer-ownership`.
 */

import { useEffect, useMemo, useState } from "react";
import { Home, ShieldCheck, Users, Wallet } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { CoManagerPermissionsEditor } from "@/components/portal/pro-account-links-panel";
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
  const [role, setRole] = useState<AfterRoleId>("admin");
  const [customPermissions, setCustomPermissions] = useState<CoManagerPermissions>(EMPTY_CO_MANAGER_PERMISSIONS);
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset every field whenever the dialog opens (including reopening on a
  // different member), so a stale pick from a previous transfer never rides
  // along into this one.
  useEffect(() => {
    if (!open) return;
    setRole("admin");
    setCustomPermissions(EMPTY_CO_MANAGER_PERMISSIONS);
    setConfirmText("");
    // member/workspace are looked up fresh on every open; keying off their
    // ids (not object identity) avoids resetting on an unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, member.userId, workspace.id]);

  const n = workspace.propertyIds.length;
  const firstName = firstNameOf(member.name);

  const formerOwnerPermissions: CoManagerPermissions = useMemo(() => {
    if (role === "nothing") return EMPTY_CO_MANAGER_PERMISSIONS;
    if (role === "custom") return customPermissions;
    return stampTeamRolePermissions(role) ?? EMPTY_CO_MANAGER_PERMISSIONS;
  }, [role, customPermissions]);

  const confirmed = confirmText.trim().toLowerCase() === workspace.name.trim().toLowerCase();

  const submit = async () => {
    if (!confirmed) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/pro/workspaces/${encodeURIComponent(workspace.id)}/transfer-ownership`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newOwnerUserId: member.userId,
          formerOwnerRole: role,
          formerOwnerPermissions,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        showToast(data.error?.trim() || "Could not transfer ownership.");
        return;
      }
      showToast(`${workspace.name} transferred to ${member.name}.`);
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`Transfer ${workspace.name} to ${member.name}`}
      onClose={onClose}
      panelClassName="max-w-lg"
      dataAttr="transfer-ownership-dialog"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="danger"
            disabled={!confirmed || submitting}
            onClick={() => submit()}
            data-attr="transfer-submit"
          >
            Transfer ownership
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <ul className="space-y-2.5" data-attr="transfer-consequences">
          <li className="flex items-start gap-2.5 text-sm text-foreground">
            <Home className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span>
              {firstName} becomes the owner of {workspace.name} — all {n} house{n === 1 ? "" : "s"}, and any added
              later.
            </span>
          </li>
          <li className="flex items-start gap-2.5 text-sm text-foreground">
            <Wallet className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span>Rent and fees for them pay out to {firstName}&apos;s bank account from the next charge.</span>
          </li>
          <li className="flex items-start gap-2.5 text-sm text-foreground">
            <Users className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span>
              Members keep their roles. {firstName} decides who works in {workspace.name} from now on.
            </span>
          </li>
          <li className="flex items-start gap-2.5 text-sm text-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span className="flex flex-wrap items-center gap-1.5">
              You stay in it as
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
          {role === "nothing" ? (
            <li className="text-sm text-foreground">
              You leave {workspace.name} entirely. {firstName} can invite you back later.
            </li>
          ) : null}
        </ul>

        {role === "custom" ? (
          <CoManagerPermissionsEditor hideRole value={customPermissions} onChange={setCustomPermissions} />
        ) : null}

        <label className="block">
          <span className="text-xs font-semibold text-muted">Type {workspace.name} to confirm</span>
          <Input
            className="mt-1"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            data-attr="transfer-confirm"
          />
        </label>
      </div>
    </Modal>
  );
}
