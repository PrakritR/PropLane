"use client";

import { useCallback, useMemo, useState } from "react";
import { isAssistantUnifiedInboxRow, isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import { resolveSmsDeletePhone } from "@/lib/communication-inbox-filters";
import { deleteManagerSmsConversationClient } from "@/lib/manager-sms-conversations-client";
import {
  archivePersistedInboxThreads,
  clearPersistedInboxThread,
  deletePersistedInboxThreadsForever,
  restorePersistedInboxThreads,
} from "@/lib/communication-inbox-thread-mutations";
import {
  archiveManagerSmsConversation,
  loadManagerSmsArchivedIds,
  persistManagerSmsArchivedIds,
  restoreManagerSmsConversation,
} from "@/lib/manager-sms-archive.client";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { useInboxRowSelection } from "@/components/portal/portal-inbox-selection";
import { parseUnifiedInboxKey, type UnifiedInboxListItem } from "@/lib/unified-inbox-merge";
import type { InboxListSegment } from "@/components/portal/portal-inbox-ui";
import type { PortalContactDetailsValues } from "@/components/portal/portal-contact-details-modal";
import { useConfirm } from "@/components/providers/app-ui-provider";

type SelectedRow = {
  key: string;
  channel: "email" | "sms";
  threadId: string;
};

export function useUnifiedCommunicationBulk({
  mergedRows,
  listSegment,
  storageKey,
  emailThreads,
  onEmailThreadsChange,
  onSelectionCleared,
  onSmsArchiveChange,
  smsTargets = [],
  onSmsDeleted,
  showToast = () => {},
  assistantPlaceholder,
}: {
  mergedRows: UnifiedInboxListItem[];
  listSegment: InboxListSegment;
  storageKey: string;
  emailThreads: PersistedInboxThread[];
  onEmailThreadsChange: (rows: PersistedInboxThread[]) => void;
  onSelectionCleared?: () => void;
  onSmsArchiveChange?: () => void;
  /** Phone + conversation key for each SMS row, so Delete can call the SMS route. */
  smsTargets?: Array<{ conversationId: string; phone: string; conversationKey: string | null }>;
  onSmsDeleted?: () => void;
  showToast?: (message: string) => void;
  /** Preview/from/subject restored after Clear PropLane Assistant. */
  assistantPlaceholder?: Pick<PersistedInboxThread, "from" | "subject" | "preview">;
}) {
  const toast = showToast;
  const selectableKeys = useMemo(() => mergedRows.map((row) => row.key), [mergedRows]);
  const selection = useInboxRowSelection(selectableKeys);

  const selectedRows = useMemo((): SelectedRow[] => {
    return mergedRows
      .filter((row) => selection.selectedIds.has(row.key))
      .flatMap((row) => [...new Set([row.key, ...(row.memberKeys ?? [])])].flatMap((key) => {
        const parsed = parseUnifiedInboxKey(key);
        return parsed ? [{ key, ...parsed }] : [];
      }));
  }, [mergedRows, selection.selectedIds]);

  const selectedEmailThreads = useMemo(() => {
    const ids = new Set(
      selectedRows.filter((row) => row.channel === "email").map((row) => row.threadId),
    );
    return emailThreads.filter((thread) => ids.has(thread.id));
  }, [emailThreads, selectedRows]);

  const canEditContact = useMemo(() => {
    if (selectedRows.length !== 1) return false;
    const row = selectedRows[0]!;
    if (row.channel !== "email") return false;
    const thread = emailThreads.find((entry) => entry.id === row.threadId);
    if (!thread || isPropLaneAssistantInboxThread(thread)) return false;
    return true;
  }, [emailThreads, selectedRows]);

  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const editInitial = useMemo(() => {
    const thread = selectedEmailThreads[0];
    if (!thread) return { name: "", email: "", phone: "" };
    return {
      name: thread.from?.trim() || "",
      email: thread.email?.trim() || "",
      phone: "",
    };
  }, [selectedEmailThreads]);

  const clearAfterBulk = useCallback(() => {
    selection.clearSelection();
    onSelectionCleared?.();
  }, [onSelectionCleared, selection]);

  const rowsFromListKeys = useCallback(
    (keys: string[]): SelectedRow[] => {
      const wanted = new Set(keys.map((key) => key.trim()).filter(Boolean));
      if (wanted.size === 0) return [];
      return mergedRows
        .filter(
          (row) =>
            wanted.has(row.key) || (row.memberKeys ?? []).some((memberKey) => wanted.has(memberKey)),
        )
        .flatMap((row) =>
          [...new Set([row.key, ...(row.memberKeys ?? [])])].flatMap((key) => {
            const parsed = parseUnifiedInboxKey(key);
            return parsed ? [{ key, ...parsed }] : [];
          }),
        );
    },
    [mergedRows],
  );

  const archiveRows = useCallback(
    async (rows: SelectedRow[], clearSelectionAfter = true) => {
      const emailIds = rows.filter((row) => row.channel === "email").map((row) => row.threadId);
      const smsIds = rows.filter((row) => row.channel === "sms").map((row) => row.threadId);

      if (emailIds.length > 0) {
        const { ok, next } = await archivePersistedInboxThreads(storageKey, emailIds);
        if (!ok) {
          showToast("Could not archive conversations.");
          return false;
        }
        onEmailThreadsChange(next);
      }

      if (smsIds.length > 0) {
        try {
          for (const id of smsIds) await archiveManagerSmsConversation(id);
          onSmsArchiveChange?.();
        } catch {
          showToast("Could not archive text conversations. Try again.");
          return false;
        }
      }

      showToast("Archived.");
      if (clearSelectionAfter) clearAfterBulk();
      return true;
    },
    [clearAfterBulk, onEmailThreadsChange, onSmsArchiveChange, showToast, storageKey],
  );

  const handleArchive = useCallback(async () => {
    await archiveRows(selectedRows, true);
  }, [archiveRows, selectedRows]);

  const handleArchiveKeys = useCallback(
    async (keys: string[]) => {
      const rows = rowsFromListKeys(keys);
      if (rows.length === 0) return;
      await archiveRows(rows, false);
    },
    [archiveRows, rowsFromListKeys],
  );

  const handleRestore = useCallback(async () => {
    const emailIds = selectedRows.filter((row) => row.channel === "email").map((row) => row.threadId);
    const smsIds = selectedRows.filter((row) => row.channel === "sms").map((row) => row.threadId);

    if (emailIds.length > 0) {
      const { ok, next } = await restorePersistedInboxThreads(storageKey, emailIds);
      if (!ok) {
        showToast("Could not restore conversations.");
        return;
      }
      onEmailThreadsChange(next);
    }

    try {
      for (const id of smsIds) await restoreManagerSmsConversation(id);
    } catch {
      showToast("Could not restore text conversations. Try again.");
      return;
    }
    if (smsIds.length > 0) onSmsArchiveChange?.();

    showToast("Restored.");
    clearAfterBulk();
  }, [
    clearAfterBulk,
    onEmailThreadsChange,
    onSmsArchiveChange,
    selectedRows,
    showToast,
    storageKey,
  ]);

  const confirm = useConfirm();

  const assistantPlaceholderFields = useCallback((threadId: string) => {
    const existing = emailThreads.find((thread) => thread.id === threadId);
    return {
      preview: assistantPlaceholder?.preview ?? existing?.preview ?? "",
      subject: assistantPlaceholder?.subject ?? existing?.subject ?? "PropLane Assistant",
      from: assistantPlaceholder?.from ?? existing?.from ?? "PropLane Assistant",
    };
  }, [assistantPlaceholder, emailThreads]);

  const clearAssistantIds = useCallback(async (ids: string[]) => {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) return true;
    let nextRows = emailThreads;
    for (const id of unique) {
      const { ok, next } = await clearPersistedInboxThread(storageKey, id, assistantPlaceholderFields(id));
      if (!ok) return false;
      nextRows = next;
    }
    onEmailThreadsChange(nextRows);
    return true;
  }, [assistantPlaceholderFields, emailThreads, onEmailThreadsChange, storageKey]);

  const deleteRowsForever = useCallback(async (
    rows: SelectedRow[],
    confirmCount: number,
    mode: "selection" | "archived-all" = "selection",
  ) => {
    const emailIds = [...new Set(
      rows
        .filter((row) => row.channel === "email" && !row.threadId.startsWith("agent_notice_") && !row.threadId.startsWith("resident-agent-"))
        .map((row) => row.threadId),
    )];
    const smsIds = [...new Set(rows.filter((row) => row.channel === "sms").map((row) => row.threadId))];
    if (emailIds.length === 0 && smsIds.length === 0) return false;
    const failToast = mode === "archived-all"
      ? "Couldn't delete archived conversations."
      : "Could not delete conversations.";
    if (!(await confirm({
      description: mode === "archived-all"
        ? `Delete ${confirmCount} archived conversation${confirmCount === 1 ? "" : "s"} forever?`
        : `Delete ${confirmCount} conversation${confirmCount === 1 ? "" : "s"} forever?`,
    }))) {
      return false;
    }

    let emailDeleted = 0;
    if (emailIds.length > 0) {
      const { ok, next } = await deletePersistedInboxThreadsForever(storageKey, emailIds);
      if (!ok) {
        showToast(failToast);
        return false;
      }
      emailDeleted = emailIds.length;
      onEmailThreadsChange(next);
    }

    let smsDeleted = 0;
    let smsFailed = 0;
    for (const id of smsIds) {
      const target = smsTargets.find((entry) => entry.conversationId === id);
      const row = mergedRows.find((entry) => {
        const key = `sms:${id}`;
        return entry.threadId === id || entry.key === key || (entry.memberKeys ?? []).includes(key);
      });
      const phone = resolveSmsDeletePhone({
        conversationId: id,
        targetPhone: target?.phone,
        rowName: row?.name,
        rowSubtitle: row?.subtitle,
      });
      const result = await deleteManagerSmsConversationClient({
        phone,
        conversationKey: target?.conversationKey ?? id,
      });
      if (!result.ok || result.partial) {
        smsFailed += 1;
        continue;
      }
      smsDeleted += 1;
    }
    if (smsIds.length > 0) onSmsDeleted?.();
    const deletedCount = emailDeleted + smsDeleted;
    if (smsFailed > 0) {
      showToast(
        deletedCount > 0
          ? `Deleted ${deletedCount}. Couldn't delete ${smsFailed} text conversation${smsFailed === 1 ? "" : "s"}.`
          : failToast,
      );
      if (deletedCount === 0) return false;
      clearAfterBulk();
      return true;
    }
    showToast("Deleted.");
    clearAfterBulk();
    return true;
  }, [
    clearAfterBulk,
    confirm,
    mergedRows,
    onEmailThreadsChange,
    onSmsDeleted,
    showToast,
    smsTargets,
    storageKey,
  ]);

  const handleDelete = useCallback(async () => {
    const conversationCount = selection.selectedIds.size;
    await deleteRowsForever(selectedRows, conversationCount || selectedRows.length);
  }, [deleteRowsForever, selectedRows, selection.selectedIds.size]);

  const handleClearAssistant = useCallback(async (
    row: UnifiedInboxListItem,
    opts?: { skipConfirm?: boolean },
  ) => {
    if (!isAssistantUnifiedInboxRow(row, emailThreads)) return false;
    if (!opts?.skipConfirm && !(await confirm({
      description: "Clear PropLane Assistant? This removes the messages. The conversation stays.",
    }))) {
      return false;
    }
    const ids = [...new Set([row.key, ...(row.memberKeys ?? [])])]
      .map(parseUnifiedInboxKey)
      .flatMap((member) => {
        if (!member || member.channel !== "email") return [];
        if (member.threadId.startsWith("agent_notice_") || member.threadId.startsWith("resident-agent-")) {
          return [member.threadId];
        }
        const thread = emailThreads.find((entry) => entry.id === member.threadId);
        return thread && isPropLaneAssistantInboxThread(thread) ? [member.threadId] : [];
      });
    const ok = await clearAssistantIds(ids);
    if (!ok) {
      showToast("Could not clear PropLane Assistant.");
      return false;
    }
    if (!opts?.skipConfirm) showToast("Cleared.");
    return true;
  }, [clearAssistantIds, confirm, emailThreads, showToast]);

  const handleDeleteAllArchived = useCallback(async () => {
    if (listSegment !== "archived") return;
    const deletable = mergedRows.filter((row) => !isAssistantUnifiedInboxRow(row, emailThreads));
    const assistantRows = mergedRows.filter((row) => isAssistantUnifiedInboxRow(row, emailThreads));
    if (deletable.length === 0) return;
    const rows: SelectedRow[] = deletable.flatMap((row) =>
      [...new Set([row.key, ...(row.memberKeys ?? [])])].flatMap((key) => {
        const parsed = parseUnifiedInboxKey(key);
        return parsed ? [{ key, ...parsed }] : [];
      }),
    );
    const ok = await deleteRowsForever(rows, deletable.length, "archived-all");
    if (!ok) return;
    for (const row of assistantRows) {
      await handleClearAssistant(row, { skipConfirm: true });
    }
  }, [deleteRowsForever, emailThreads, handleClearAssistant, listSegment, mergedRows]);

  const openEdit = useCallback(() => {
    setEditError(null);
    setEditOpen(true);
  }, []);

  const saveEdit = useCallback(
    async (values: PortalContactDetailsValues, savePath: "manager" | "resident" | "vendor") => {
      const thread = selectedEmailThreads[0];
      const email = values.email || thread?.email?.trim().toLowerCase();
      if (!email) {
        setEditError("Enter an email address.");
        return;
      }
      setEditSaving(true);
      setEditError(null);
      try {
        if (savePath === "manager") {
          const res = await fetch("/api/manager/sms-contacts", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              phone: values.phone,
              email,
              displayName: (values.name || thread?.from || email).slice(0, 80),
            }),
          });
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(body.error ?? "Could not save contact details.");
        } else {
          void savePath;
          showToast("Contact edit is not available for this portal yet.");
          return;
        }
        setEditOpen(false);
        showToast("Contact details saved.");
        clearAfterBulk();
      } catch (error) {
        setEditError(error instanceof Error ? error.message : "Could not save contact details.");
      } finally {
        setEditSaving(false);
      }
    },
    [clearAfterBulk, selectedEmailThreads, showToast],
  );

  const archiveSmsConversation = useCallback(
    async (conversationId: string) => {
      await archiveManagerSmsConversation(conversationId);
      onSmsArchiveChange?.();
    },
    [onSmsArchiveChange],
  );

  return {
    selection,
    selectedRows,
    selectedCount: selection.selectedIds.size,
    canEditContact,
    editOpen,
    setEditOpen,
    editSaving,
    editError,
    editInitial,
    openEdit,
    saveEdit,
    handleArchive,
    handleArchiveKeys,
    handleRestore,
    handleDelete,
    handleClearAssistant,
    handleDeleteAllArchived,
    archiveSmsConversation,
    parseRowKey: parseUnifiedInboxKey,
  };
}
