"use client";

import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import type { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
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
  const permitted = members.every((member) => {
    if (!member) return false;
    if (member.channel === "sms") return manager;
    const thread = emailThreads.find((entry) => entry.id === member.threadId);
    return Boolean(thread && !isPropLaneAssistantInboxThread(thread));
  });
  const emailOnly = members.every((member) => member?.channel === "email");
  return (
    <RecordActionContext.Provider value={{
      scope: `${archived}:${row.key}`,
      clear: bulk.selection.clearSelection,
      actions: permitted ? <>
        {archived ? <>
          <Button variant="outline" onClick={() => bulk.handleRestore()}>Restore</Button>
          {emailOnly ? <Button variant="danger" onClick={() => bulk.handleDelete()}>Delete</Button> : null}
        </> : <Button variant="outline" onClick={() => bulk.handleArchive()}>Archive</Button>}
        {manager && bulk.canEditContact ? <Button variant="outline" onClick={bulk.openEdit}>Edit</Button> : null}
      </> : null,
    }}>
      <RecordActionMenu label={row.name} activate={() => bulk.selection.toggleSelected(row.key)} />
    </RecordActionContext.Provider>
  );
}
