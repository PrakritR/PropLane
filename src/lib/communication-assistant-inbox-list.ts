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
import { portalSessionViewerId } from "@/lib/auth/portal-session-gate";
import {
  inboxThreadMessages,
  inboxThreadSortMs,
  resolveCollapsedInboxThread,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { unifiedInboxKey, type UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

type InboxListSegment = "active" | "unread" | "archived";

export const MANAGER_AGENT_NOTICE_FROM_NAME = "PropLane Assistant";

/** User-visible channel label for in-app PropLane Assistant threads (not email/SMS). */
export const PROPLANE_ASSISTANT_CHANNEL_LABEL = "PropLane";

export function managerAgentNoticeThreadId(landlordId: string): string {
  return `agent_notice_${landlordId.trim()}`;
}

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

export function buildManagerAssistantPlaceholderThread(landlordId: string): PersistedInboxThread {
  const id = managerAgentNoticeThreadId(landlordId);
  return {
    id,
    folder: "inbox",
    from: MANAGER_AGENT_NOTICE_FROM_NAME,
    email: "",
    subject: "PropLane Assistant",
    preview: "Ask about your portfolio, residents, leases, and maintenance.",
    time: "",
    unread: false,
    threadType: "agent_notice",
  } as PersistedInboxThread;
}

export function ensureAssistantThreadInRows(
  threads: PersistedInboxThread[],
  placeholder: PersistedInboxThread,
): PersistedInboxThread[] {
  if (
    threads.some(
      (thread) =>
        thread.id === placeholder.id || isPropLaneAssistantInboxThread(thread),
    )
  ) {
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

/** Inject a placeholder assistant row on Active when the server list is still empty. */
export function withPinnedPropLaneAssistantThreads(
  threads: PersistedInboxThread[],
  portal: CommunicationAssistantPortal,
  viewerId: string | null | undefined,
  listSegment: InboxListSegment,
): PersistedInboxThread[] {
  if (!viewerId?.trim() || listSegment !== "active") return threads;
  const placeholder =
    portal === "resident"
      ? buildResidentAssistantPlaceholderThread(viewerId)
      : buildManagerAssistantPlaceholderThread(viewerId);
  return ensureAssistantThreadInRows(threads, placeholder);
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
  if (index <= 0) return items;
  const assistant = items[index]!;
  return [assistant, ...items.filter((item) => item.threadId !== id)];
}

export function propLaneAssistantThreadIdForPortal(
  portal: CommunicationAssistantPortal,
  viewerId: string,
): string {
  return portal === "resident"
    ? canonicalResidentAgentThreadId(viewerId)
    : managerAgentNoticeThreadId(viewerId);
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
  const assistantId = viewerId?.trim()
    ? propLaneAssistantThreadIdForPortal(portal, viewerId.trim())
    : null;
  if (!assistantId || expandedId !== assistantId) return null;
  return portal === "resident"
    ? buildResidentAssistantPlaceholderThread(viewerId.trim())
    : buildManagerAssistantPlaceholderThread(viewerId.trim());
}
