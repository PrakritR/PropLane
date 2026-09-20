/**
 * Client-safe helpers so PropLane Assistant always appears in Communication
 * lists even before the first server sync completes.
 */
import {
  RESIDENT_AGENT_FROM_NAME,
  RESIDENT_AGENT_THREAD_TYPE,
  canonicalResidentAgentThreadId,
} from "@/lib/agent/resident-inbox-agent-ids";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import {
  managerAgentNoticeThreadId,
  parseManagerAgentNoticeThreadId,
  type ManagerAssistantWorkspace,
} from "@/lib/communication-manager-assistant-thread";
import { portalSessionViewerId } from "@/lib/auth/portal-session-gate";
import {
  inboxThreadMessages,
  inboxThreadSortMs,
  resolveCollapsedInboxThread,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { unifiedInboxKey, type UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

export { managerAgentNoticeThreadId } from "@/lib/communication-manager-assistant-thread";

type InboxListSegment = "active" | "unread" | "archived";

export const MANAGER_AGENT_NOTICE_FROM_NAME = "PropLane Assistant";

/** User-visible channel label for in-app PropLane Assistant threads (not email/SMS). */
export const PROPLANE_ASSISTANT_CHANNEL_LABEL = "PropLane";

export function buildResidentAssistantPlaceholderThread(residentUserId: string): PersistedInboxThread {
  const id = canonicalResidentAgentThreadId(residentUserId);
  return {
    id,
    folder: "inbox",
    from: RESIDENT_AGENT_FROM_NAME,
    email: "",
    subject: "Ask PropLane",
    preview: "Ask about your lease, rent, maintenance or upcoming visits.",
    time: "",
    unread: false,
    threadType: RESIDENT_AGENT_THREAD_TYPE,
  } as PersistedInboxThread;
}

export function buildManagerAssistantPlaceholderThread(
  landlordId: string,
  workspace?: ManagerAssistantWorkspace | null,
): PersistedInboxThread {
  const id = managerAgentNoticeThreadId(landlordId, workspace);
  return {
    id,
    folder: "inbox",
    from: MANAGER_AGENT_NOTICE_FROM_NAME,
    email: "",
    subject: "PropLane Assistant",
    preview: "Ask about this workspace’s portfolio, residents, leases, and maintenance.",
    time: "",
    unread: false,
    threadType: "agent_notice",
  } as PersistedInboxThread;
}

export function ensureAssistantThreadInRows(
  threads: PersistedInboxThread[],
  placeholder: PersistedInboxThread,
): PersistedInboxThread[] {
  const index = threads.findIndex((thread) => thread.id === placeholder.id);
  if (index >= 0) {
    const existing = threads[index]!;
    if (existing.folder === "trash") {
      const next = [...threads];
      next[index] = { ...existing, folder: "inbox" };
      return next;
    }
    return threads;
  }
  return [placeholder, ...threads];
}

export type CommunicationAssistantPortal = "resident" | "manager";

/** Prefer a server-provided id, then the portal session hook, then the global latch. */
export function resolveCommunicationViewerId(
  serverUserId: string | null | undefined,
  sessionUserId: string | null | undefined,
): string | null {
  const fromServer = serverUserId?.trim();
  if (fromServer) return fromServer;
  const fromSession = sessionUserId?.trim();
  if (fromSession) return fromSession;
  return portalSessionViewerId();
}

/**
 * Inject / restore the viewer’s PropLane Assistant row.
 * Manager: Active and Unread only, keyed by workspace — Archived is a real
 * archive, so the live Assistant thread is not pinned there.
 * Resident: Active only (unchanged).
 */
export function withPinnedPropLaneAssistantThreads(
  threads: PersistedInboxThread[],
  portal: CommunicationAssistantPortal,
  viewerId: string | null | undefined,
  listSegment: InboxListSegment,
  workspace?: ManagerAssistantWorkspace | null,
): PersistedInboxThread[] {
  if (!viewerId?.trim()) return threads;
  if (portal === "resident") {
    if (listSegment !== "active") return threads;
    return ensureAssistantThreadInRows(threads, buildResidentAssistantPlaceholderThread(viewerId));
  }
  const placeholder = buildManagerAssistantPlaceholderThread(viewerId, workspace);
  const liveId = placeholder.id;
  const viewer = viewerId.trim().toLowerCase();
  // Leftover chats from other workspaces stay stored (and may still be unread)
  // but they are not this workspace's Assistant row — they must not keep the
  // Communication sidebar badge after the live notice has been seen.
  const scoped = threads.filter((thread) => {
    const parsed = parseManagerAgentNoticeThreadId(thread.id);
    if (!parsed || parsed.userId.toLowerCase() !== viewer) return true;
    return thread.id === liveId;
  });
  if (listSegment === "archived") return scoped;
  return ensureAssistantThreadInRows(scoped, placeholder);
}

function previewLine(body: string, max = 80): string {
  const t = body.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** Archived rows omit empty / placeholder preview copy so the list stays compact. */
export function communicationInboxListPreview(
  text: string,
  listSegment: InboxListSegment,
  max = 80,
): string {
  const line = previewLine(text, max);
  if (listSegment === "archived" && (!line || line === "No messages yet.")) return "";
  return line;
}

export function assistantUnifiedListItemFromThread(
  thread: PersistedInboxThread,
  listSegment: InboxListSegment = "active",
): UnifiedInboxListItem {
  const msgs = inboxThreadMessages(thread);
  const lastMsg = msgs[msgs.length - 1];
  const sentSemantics = thread.folder === "sent";
  return {
    key: unifiedInboxKey("email", thread.id),
    channel: "email",
    threadId: thread.id,
    name: thread.from?.trim() || RESIDENT_AGENT_FROM_NAME,
    subtitle: propLaneAssistantListSubtitle(thread),
    preview: propLaneAssistantListPreview(thread, listSegment),
    previewPrefix: sentSemantics ? "You: " : undefined,
    time: thread.time,
    unread: thread.folder === "inbox" && thread.unread,
    sortMs: inboxThreadSortMs(thread.id, thread.time) || Date.now(),
  };
}

/** Keep PropLane Assistant at the top of the Active list when present. */
export function pinPropLaneAssistantUnifiedItems(
  items: UnifiedInboxListItem[],
  assistantThreadId: string | null | undefined,
): UnifiedInboxListItem[] {
  const id = assistantThreadId?.trim();
  if (!id) return items;
  const index = items.findIndex((item) => item.threadId === id);
  if (index < 0) return items;
  if (index === 0) return items;
  const assistant = items[index]!;
  return [assistant, ...items.filter((item) => item.threadId !== id)];
}

/** Put the live assistant row first even when the section filter dropped it (Unread / Archived). */
export function ensurePinnedManagerAssistantUnifiedItems(
  items: UnifiedInboxListItem[],
  assistant: UnifiedInboxListItem | null | undefined,
): UnifiedInboxListItem[] {
  if (!assistant?.threadId) return items;
  const without = items.filter((item) => item.threadId !== assistant.threadId);
  return [assistant, ...without];
}

export function propLaneAssistantThreadIdForPortal(
  portal: CommunicationAssistantPortal,
  viewerId: string,
  workspace?: ManagerAssistantWorkspace | null,
): string {
  return portal === "resident"
    ? canonicalResidentAgentThreadId(viewerId)
    : managerAgentNoticeThreadId(viewerId, workspace);
}

export function propLaneAssistantListSubtitle(thread: PersistedInboxThread): string {
  return isPropLaneAssistantInboxThread(thread)
    ? PROPLANE_ASSISTANT_CHANNEL_LABEL
    : thread.subject?.trim() || "";
}

/** Longer preview for assistant rows so the onboarding copy is not clipped at 80 chars. */
export function propLaneAssistantListPreview(
  thread: PersistedInboxThread,
  listSegment: InboxListSegment,
): string {
  const msgs = inboxThreadMessages(thread);
  const lastMsg = msgs[msgs.length - 1];
  const raw = lastMsg?.body ?? thread.preview ?? "";
  return communicationInboxListPreview(raw, listSegment, 160);
}

/**
 * Open the assistant placeholder even before it is persisted — the unified list
 * pins it in React state first.
 */
export function resolveCommunicationInboxThread(
  expandedId: string | null,
  collapsed: PersistedInboxThread[],
  raw: PersistedInboxThread[],
  portal: CommunicationAssistantPortal,
  viewerId: string | null | undefined,
): PersistedInboxThread | null {
  if (!expandedId) return null;
  const stored = resolveCollapsedInboxThread(expandedId, collapsed, raw);
  if (stored) return stored;
  // Hoisted so the non-empty check narrows the value the builders actually
  // receive. Trimming again below reads as safe but does not typecheck: the
  // compiler cannot carry the narrowing across `assistantId`.
  const viewer = viewerId?.trim() ?? "";
  const assistantId = viewer ? propLaneAssistantThreadIdForPortal(portal, viewer) : null;
  const matchesAssistant =
    expandedId === assistantId ||
    (portal === "manager" && expandedId.startsWith(`agent_notice_${viewer}`));
  if (!matchesAssistant) return null;
  return portal === "resident"
    ? buildResidentAssistantPlaceholderThread(viewer)
    : { ...buildManagerAssistantPlaceholderThread(viewer), id: expandedId };
}
