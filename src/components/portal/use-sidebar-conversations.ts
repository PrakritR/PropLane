"use client";

import { useEffect, useMemo, useState } from "react";
import { usePortalSession } from "@/hooks/use-portal-session";
import { buildActiveCommunicationThreads } from "@/lib/communication-active-rows";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import {
  inboxThreadSortMs,
  loadPersistedInbox,
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  RESIDENT_INBOX_STORAGE_KEY,
  VENDOR_INBOX_STORAGE_KEY,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import type { PortalKind } from "@/lib/portal-types";
import { activeWorkspaceIdentity, WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";

export type SidebarConversation = {
  id: string;
  name: string;
  initials: string;
  unread: boolean;
  href: string;
};

export const SIDEBAR_CONVERSATION_LIMIT = 5;

function conversationInitials(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * The most recent conversations, newest first, as the sidebar's Conversations
 * rows. Pure so it is testable: it takes the rows the Communication list itself
 * reads (the persisted inbox store, which the server fills per active
 * workspace) and applies the same Active row-building the Communication badge
 * uses, minus the pinned assistant thread (that is not a person).
 */
export function recentSidebarConversations(
  rows: PersistedInboxThread[],
  opts: {
    kind: PortalKind;
    basePath: string;
    viewerId: string | null | undefined;
    workspace: { id: string; isDefault: boolean } | null;
    smsUiEnabled?: boolean;
    limit?: number;
  },
): SidebarConversation[] {
  const portal = opts.kind === "resident" ? "resident" : "manager";
  const active =
    opts.kind === "vendor"
      ? rows
      : buildActiveCommunicationThreads(rows, {
          portal,
          viewerId: opts.viewerId,
          workspace: opts.workspace,
          smsUiEnabled: opts.smsUiEnabled ?? false,
        });
  return active
    .filter((thread) => thread.folder !== "trash" && !isPropLaneAssistantInboxThread(thread))
    .sort((a, b) => inboxThreadSortMs(b.id, b.time) - inboxThreadSortMs(a.id, a.time))
    .slice(0, opts.limit ?? SIDEBAR_CONVERSATION_LIMIT)
    .map((thread) => {
      const name = (thread.from || thread.email || "Conversation").trim();
      return {
        id: thread.id,
        name,
        initials: conversationInitials(name),
        unread: thread.folder === "inbox" && thread.unread === true,
        href: `${opts.basePath}/communication/active/${encodeURIComponent(thread.id)}`,
      };
    });
}

function inboxKeyFor(kind: PortalKind): string | null {
  switch (kind) {
    case "manager":
    case "pro":
      return MANAGER_INBOX_STORAGE_KEY;
    case "resident":
      return RESIDENT_INBOX_STORAGE_KEY;
    case "vendor":
      return VENDOR_INBOX_STORAGE_KEY;
    default:
      return null;
  }
}

/**
 * Live Conversations for the sidebar. It reads the persisted inbox store: the
 * very same `GET /api/portal-inbox-threads` answer the Communication list
 * renders, which is already keyed on viewer AND active workspace and carries its
 * own TTL + in-flight guard (so this adds no request of its own). It re-reads when
 * the inbox changes and when the workspace selection changes, so switching a
 * workspace tile re-points the list at that workspace.
 */
export function useSidebarConversations({
  kind,
  basePath,
  enabled,
  smsUiEnabled = false,
}: {
  kind: PortalKind;
  basePath: string;
  enabled: boolean;
  smsUiEnabled?: boolean;
}): SidebarConversation[] {
  const session = usePortalSession();
  const [tick, setTick] = useState(0);
  const key = inboxKeyFor(kind);

  useEffect(() => {
    if (!enabled || !key) return;
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, bump);
    window.addEventListener(WORKSPACE_SELECTION_EVENT, bump);
    return () => {
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, bump);
      window.removeEventListener(WORKSPACE_SELECTION_EVENT, bump);
    };
  }, [enabled, key]);

  return useMemo(() => {
    void tick;
    if (!enabled || !key || !session.ready) return [];
    try {
      return recentSidebarConversations(loadPersistedInbox(key, []), {
        kind,
        basePath,
        viewerId: session.userId,
        workspace: activeWorkspaceIdentity(),
        smsUiEnabled,
      });
    } catch {
      return [];
    }
  }, [basePath, enabled, key, kind, session.ready, session.userId, smsUiEnabled, tick]);
}
