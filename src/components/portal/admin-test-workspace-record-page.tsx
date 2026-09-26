"use client";

import type { ReactNode } from "react";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { RecordFactCard, RecordFactRow, RecordRowsCard } from "@/components/portal/portal-record-overview-kit";
import { Button } from "@/components/ui/button";
import { formatPacificDate } from "@/lib/pacific-time";

export type AdminTestWorkspaceMember = {
  id: string;
  email: string;
  fullName: string;
  role: "manager" | "co_manager" | "resident";
  state: "active" | "suspended";
  expiresAt: string | null;
  createdAt: string;
};

export type AdminTestWorkspaceRecord = {
  id: string;
  name: string;
  status: "active" | "suspended";
  createdAt: string;
  members: AdminTestWorkspaceMember[];
};

/**
 * A test workspace's record (C168): workspace facts plus its member list, in
 * place of the former inline accordion — same shape `admin-property-record-page.tsx`
 * (C163) and `admin-account-record-page.tsx` (C165) already established for
 * Admin.
 */
export function AdminTestWorkspaceRecordPage({
  workspace,
  backHref,
  busyId,
  onInviteMember,
  onToggleMember,
  inviteForm,
}: {
  workspace: AdminTestWorkspaceRecord;
  backHref: string;
  /** The id of whatever this page is waiting on, or `create-workspace` / `invite:<id>` from the parent. `null` when idle. */
  busyId: string | null;
  onInviteMember: () => void;
  onToggleMember: (member: AdminTestWorkspaceMember) => void;
  /** The parent's inline invite form, rendered under the member list while open. */
  inviteForm?: ReactNode;
}) {
  const activeMembers = workspace.members.filter((member) => member.state === "active").length;

  return (
    <PortalRecordDetailPage
      title={workspace.name}
      subtitle={`${activeMembers} active of ${workspace.members.length} accounts`}
      avatarName={workspace.name}
      backHref={backHref}
      backLabel="Test accounts"
    >
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
        <RecordFactCard title="Overview" dataAttr="admin-test-workspace-overview">
          <RecordFactRow label="Status" value={workspace.status === "active" ? "Active" : "Suspended"} />
          <RecordFactRow
            label="Created"
            value={formatPacificDate(workspace.createdAt, { year: "numeric", month: "short", day: "numeric" })}
          />
          <RecordFactRow label="Accounts" value={`${activeMembers} active of ${workspace.members.length}`} />
        </RecordFactCard>

        <RecordRowsCard
          title="Workspace accounts"
          dataAttr="admin-test-workspace-members"
          emptyLabel="No accounts have been invited to this workspace."
          footer={{ label: "Invite account", onClick: onInviteMember }}
          rows={workspace.members.map((member) => ({
            id: member.id,
            title: member.fullName || member.email,
            sub: `${member.email} · ${member.role} · ${member.state}`,
            figure: (
              <Button
                type="button"
                variant="outline"
                disabled={busyId !== null}
                onClick={() => onToggleMember(member)}
                data-attr="admin-test-workspace-member-toggle"
              >
                {busyId === member.id ? "Updating…" : member.state === "active" ? "Suspend" : "Restore"}
              </Button>
            ),
          }))}
        />

        {inviteForm}
      </div>
    </PortalRecordDetailPage>
  );
}
