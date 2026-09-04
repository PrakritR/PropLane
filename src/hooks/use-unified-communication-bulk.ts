"use client";

import { useCallback, useMemo, useState } from "react";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import {
  archivePersistedInboxThreads,
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
  showToast = () => {},
}: {
  mergedRows: UnifiedInboxListItem[];
  listSegment: InboxListSegment;
  storageKey: string;
  emailThreads: PersistedInboxThread[];
  onEmailThreadsChange: (rows: PersistedInboxThread[]) => void;
  onSelectionCleared?: () => void;
  onSmsArchiveChange?: () => void;
  showToast?: (message: string) => void;
}) {
  const toast = showToast;
  const selectableKeys = useMemo(() => mergedRows.map((row) => row.key), [mergedRows]);
  const selection = useInboxRowSelection(selectableKeys);

  const selectedRows = useMemo((): SelectedRow[] => {
    return mergedRows
      .filter((row) => selection.selectedIds.has(row.key))
      .map((row) => ({
        key: row.key,
        channel: row.channel,
        threadId: row.threadId,
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

  const handleArchive = useCallback(async () => {
    const emailIds = selectedRows.filter((row) => row.channel === "email").map((row) => row.threadId);
    const smsIds = selectedRows.filter((row) => row.channel === "sms").map((row) => row.threadId);

    if (emailIds.length > 0) {
      const { ok, next } = await archivePersistedInboxThreads(storageKey, emailIds);
      if (!ok) {
        showToast("Could not archive conversations.");
        return;
      }
      onEmailThreadsChange(next);
    }

    if (smsIds.length > 0) {
      const archived = loadManagerSmsArchivedIds();
      for (const id of smsIds) archived.add(id);
      persistManagerSmsArchivedIds(archived);
      onSmsArchiveChange?.();
    }

    showToast("Archived.");
    clearAfterBulk();
  }, [
    clearAfterBulk,
    onEmailThreadsChange,
    onSmsArchiveChange,
    selectedRows,
    showToast,
    storageKey,
  ]);

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

    for (const id of smsIds) {
      restoreManagerSmsConversation(id);
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

  const handleDelete = useCallback(async () => {
    const emailIds = selectedRows.filter((row) => row.channel === "email").map((row) => row.threadId);
    if (emailIds.length === 0) return;
    if (!window.confirm(`Delete ${emailIds.length} conversation${emailIds.length === 1 ? "" : "s"} forever?`)) {
      return;
    }
    const { ok, next } = await deletePersistedInboxThreadsForever(storageKey, emailIds);
    if (!ok) {
      showToast("Could not delete conversations.");
      return;
    }
    onEmailThreadsChange(next);
    showToast("Deleted.");
    clearAfterBulk();
  }, [clearAfterBulk, onEmailThreadsChange, selectedRows, showToast, storageKey]);

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
    (conversationId: string) => {
      archiveManagerSmsConversation(conversationId);
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
    handleRestore,
    handleDelete,
    archiveSmsConversation,
    parseRowKey: parseUnifiedInboxKey,
  };
}
