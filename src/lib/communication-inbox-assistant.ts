import {
  RESIDENT_AGENT_FROM_NAME,
  RESIDENT_AGENT_THREAD_TYPE,
  canonicalResidentAgentThreadId,
  parseResidentAgentThreadId,
} from "@/lib/agent/resident-inbox-agent-ids";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { managerAgentNoticeCollapseKey } from "@/lib/communication-manager-assistant-thread";

export { canonicalResidentAgentThreadId, parseResidentAgentThreadId };

export function isPropLaneAssistantInboxThread(thread: PersistedInboxThread): boolean {
  const extended = thread as PersistedInboxThread & { threadType?: string };
  if (extended.threadType === RESIDENT_AGENT_THREAD_TYPE) return true;
  if (extended.threadType === "agent_notice") return true;
  if (thread.id.startsWith("resident-agent-")) return true;
  if (thread.id.startsWith("agent_notice_")) return true;
  if (thread.from.trim() === RESIDENT_AGENT_FROM_NAME) return true;
  return false;
}

/**
 * The manager<->manager Team thread (WS5, `team-comms.server.ts`). Like the
 * assistant threads it has no email/SMS counterparty: a reply is a PropLane
 * post into the thread, which the send route turns into a team post plus its
 * SMS mirror.
 */
export function isTeamInboxThread(thread: Pick<PersistedInboxThread, "id"> & { threadType?: string }): boolean {
  return thread.threadType === "team" || thread.id.startsWith("team-thread:");
}

/** Group key for collapsing duplicate assistant threads in one inbox scope. */
export function assistantInboxCollapseKey(thread: PersistedInboxThread): string | null {
  const extended = thread as PersistedInboxThread & { threadType?: string };
  if (extended.threadType === RESIDENT_AGENT_THREAD_TYPE || thread.id.startsWith("resident-agent-")) {
    const parsed = parseResidentAgentThreadId(thread.id);
    if (parsed) return `resident_agent:${parsed.residentUserId}`;
  }
  if (extended.threadType === "agent_notice" || thread.id.startsWith("agent_notice_")) {
    return managerAgentNoticeCollapseKey(thread.id);
  }
  if (thread.from.trim() === RESIDENT_AGENT_FROM_NAME) {
    const parsed = parseResidentAgentThreadId(thread.id);
    if (parsed) return `resident_agent:${parsed.residentUserId}`;
  }
  return null;
}

export function boundManagerUserIdFromThread(
  thread: PersistedInboxThread,
): string | null {
  const extended = thread as PersistedInboxThread & { boundManagerUserId?: string };
  const bound = extended.boundManagerUserId?.trim();
  if (bound) return bound;
  const parsed = parseResidentAgentThreadId(thread.id);
  return parsed?.managerUserId ?? null;
}
