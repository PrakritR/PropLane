"use client";

/**
 * Admin Communication: where a text thread lives. A thread routed to a PropLane Service workspace names it as a plain
 * fact with an "Open in workspace" icon action; a thread nobody holds yet says Unassigned, and a PropLane-line lead
 * (a stranger who has not picked a house) can be assigned to a service workspace from here.
 */
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { InboxComposer, InboxThreadView, type InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  assignLeadToServiceWorkspace,
  openAdminWorkspaceThread,
  replyToLead,
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
 * A PropLane-line lead before any workspace holds it: the stranger's side of the conversation (their number is masked and
 * never reaches the browser), a composer that answers from the PropLane line, and, in the thread header, the action that
 * hands the lead to a service workspace. The reply goes to the lead by id; the server resolves the number.
 */
export function AdminLeadThread({
  resident,
  onBack,
  onAssigned,
  onSent,
}: {
  resident: ManagerSmsResidentConversation;
  onBack: () => void;
  onAssigned: () => void;
  /** A reply was accepted; the list re-reads so the sent text shows in the thread. */
  onSent?: () => void;
}) {
  const { showToast } = useAppUi();
  const workspaces = useAdminSmsWorkspaces();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
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
  const send = async () => {
    const text = draft.trim();
    if (!leadId || !text || sending) return;
    setSending(true);
    const result = await replyToLead({ leadId, text });
    setSending(false);
    // Clear only on success, so a refused send (opted out, line down) never loses what was typed.
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    setDraft("");
    showToast("Reply sent.");
    onSent?.();
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
          headerActions={
            <div className="flex items-center gap-2" data-attr="admin-communication-assign-header">
              <FieldSingleSelect
                label="Assign to workspace"
                hideLabel
                variant="pill"
                value={target}
                onChange={setTarget}
                options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
                placeholder="Assign to workspace"
                dataAttr="admin-communication-assign-workspace"
              />
              {target ? (
                <Button data-attr="admin-communication-assign-submit" onClick={() => assign()}>
                  Assign
                </Button>
              ) : null}
            </div>
          }
          composer={
            <InboxComposer
              value={draft}
              onChange={setDraft}
              onSubmit={() => void send()}
              sending={sending}
              placeholder="Reply from the PropLane line…"
              dataAttr="admin-communication-lead-reply"
            />
          }
        />
      </div>
    </div>
  );
}
