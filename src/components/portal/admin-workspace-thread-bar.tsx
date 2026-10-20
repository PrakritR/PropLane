"use client";

/**
 * Admin Communication: where a text thread lives. A thread routed to a PropLane Service workspace names it as a plain
 * fact with an "Open in workspace" icon action; a thread nobody holds yet says Unassigned, and a PropLane-line lead
 * (a stranger who has not picked a house) can be assigned to a service workspace from here.
 */
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { InboxThreadView, type InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  assignLeadToServiceWorkspace,
  openAdminWorkspaceThread,
  useAdminSmsWorkspaces,
} from "@/lib/admin-sms-workspaces";
import { formatInboxStamp } from "@/lib/portal-inbox-storage";
import { ADMIN_UNASSIGNED_WORKSPACE_LABEL, type ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

type Placement = Pick<ManagerSmsResidentConversation, "workspaceId" | "workspaceName" | "conversationKey" | "unassignedLeadId">;

/** The workspace line above a text thread: "Workspace  <name>" and the Open action; Unassigned for a thread nobody holds. */
export function AdminWorkspaceBar({ placement }: { placement: Placement }) {
  const { showToast } = useAppUi();
  const [opening, setOpening] = useState(false);
  const workspaceId = placement.workspaceId?.trim() || "";
  return (
    <div
      className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm"
      data-attr="admin-communication-workspace-bar"
    >
      <span className="text-foreground/60">Workspace</span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground" data-attr="admin-communication-workspace-name">
        {workspaceId ? placement.workspaceName?.trim() || "Workspace" : ADMIN_UNASSIGNED_WORKSPACE_LABEL}
      </span>
      {workspaceId ? (
        <PortalIconAction
          icon={ExternalLink}
          label="Open in workspace"
          data-attr="admin-communication-open-in-workspace"
          disabled={opening}
          onClick={async () => {
            setOpening(true);
            const result = await openAdminWorkspaceThread({ workspaceId, conversationKey: placement.conversationKey });
            if (!result.ok) {
              setOpening(false);
              showToast(result.error);
            }
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * A PropLane-line lead before any workspace holds it: the stranger's side of the conversation, read-only (their number
 * is masked), with the one thing admin can do - hand it to a service workspace.
 */
export function AdminLeadThread({
  resident,
  onBack,
  onAssigned,
}: {
  resident: ManagerSmsResidentConversation;
  onBack: () => void;
  onAssigned: () => void;
}) {
  const { showToast } = useAppUi();
  const workspaces = useAdminSmsWorkspaces();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const leadId = resident.unassignedLeadId?.trim() || "";
  const bubbles: InboxBubbleMessage[] = resident.messages.map((message) => ({
    id: message.id,
    author: message.direction === "inbound" ? resident.name : "PropLane",
    body: message.body,
    at: formatInboxStamp(new Date(message.createdAt)),
    direction: message.direction,
    channel: "sms",
  }));
  const assign = async () => {
    if (!leadId || !target || busy) return;
    setBusy(true);
    const result = await assignLeadToServiceWorkspace({ leadId, workspaceId: target });
    setBusy(false);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    showToast("Assigned to the workspace.");
    onAssigned();
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-attr="admin-communication-lead-thread">
      <AdminWorkspaceBar placement={resident} />
      <div className="min-h-0 flex-1">
        <InboxThreadView
          title={resident.name}
          avatarName={resident.name}
          messages={bubbles}
          threadKey={resident.conversationKey}
          onBack={onBack}
          emptyLabel="No messages in this conversation."
          composer={
            <div className="flex flex-wrap items-end gap-2 border-t border-border px-4 py-3">
              <div className="min-w-[14rem] flex-1">
                <FieldSingleSelect
                  label="Assign to"
                  value={target}
                  onChange={setTarget}
                  options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
                  placeholder="Choose a workspace"
                  dataAttr="admin-communication-assign-workspace"
                />
              </div>
              <Button data-attr="admin-communication-assign-submit" disabled={!target} onClick={() => assign()}>
                Assign
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}
