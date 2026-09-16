"use client";

import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import type { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import { assistantInboxCollapseKey } from "@/lib/communication-inbox-assistant";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { parseUnifiedInboxKey, type UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

export function CommunicationRowActions({ row, bulk, archived, emailThreads, manager = false }: {
  row: UnifiedInboxListItem;
  bulk: ReturnType<typeof useUnifiedCommunicationBulk>;
  archived: boolean;
  emailThreads: PersistedInboxThread[];
  manager?: boolean;
}) {
  const members = [...new Set([row.key, ...(row.memberKeys ?? [])])].map(parseUnifiedInboxKey);
  // Archive and restore are for EVERY conversation, PropLane Assistant and the
  // assistant-email mirror ("PropLane admin") included — the folder change is
  // the same server call the open-thread header already makes for them. A text
  // conversation can only be archived by the manager portal's SMS action.
  // Members are not checked against `emailThreads`: a merged person-row can
  // carry a stale source id from an earlier merge that the list no longer
  // returns, and requiring every member to be present left such a row with
  // "No actions available." while the header could still archive it. The
  // mutations only send the ids the list actually holds.
  const permitted = members.every((member) => {
    if (!member) return false;
    return member.channel !== "sms" || manager;
  });
  const emailOnly = members.every((member) => member?.channel === "email");
  // Delete forever stays off the canonical Assistant thread: the server
  // re-creates it empty on the next list load, so "delete" would only erase
  // the notice history. A person thread the assistant merely spoke first in
  // (the assistant-email mirror) is an ordinary conversation and keeps Delete.
  const assistantRow = members.some((member) => {
    if (!member || member.channel !== "email") return false;
    const thread = emailThreads.find((entry) => entry.id === member.threadId);
    return Boolean(thread && assistantInboxCollapseKey(thread));
  });
  return (
    <RecordActionContext.Provider value={{
      scope: `${archived}:${row.key}`,
      clear: bulk.selection.clearSelection,
      actions: permitted ? <>
        {archived ? <>
          <Button variant="outline" onClick={() => bulk.handleRestore()}>Restore</Button>
          {emailOnly && !assistantRow ? <Button variant="danger" onClick={() => bulk.handleDelete()}>Delete</Button> : null}
        </> : <Button variant="outline" onClick={() => bulk.handleArchive()}>Archive</Button>}
        {manager && bulk.canEditContact ? <Button variant="outline" onClick={bulk.openEdit}>Edit</Button> : null}
      </> : null,
    }}>
      <RecordActionMenu label={row.name} activate={() => bulk.selection.toggleSelected(row.key)} />
    </RecordActionContext.Provider>
  );
}
