import {
  RESIDENT_AGENT_FROM_NAME,
  RESIDENT_AGENT_THREAD_TYPE,
} from "@/lib/agent/resident-inbox-agent.server";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const RESIDENT_AGENT_ID_RE =
  /^resident-agent-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/i;

const AGENT_NOTICE_ID_RE = /^agent_notice_([0-9a-f-]{36})/i;

export function canonicalResidentAgentThreadId(residentUserId: string): string {
  return `resident-agent-${residentUserId}`;
}

export function parseResidentAgentThreadId(threadId: string): {
  residentUserId: string;
  managerUserId?: string;
} | null {
  const match = threadId.trim().match(RESIDENT_AGENT_ID_RE);
  if (!match) return null;
  return {
    residentUserId: match[1]!,
    managerUserId: match[2],
  };
}

export function isPropLaneAssistantInboxThread(thread: PersistedInboxThread): boolean {
  const extended = thread as PersistedInboxThread & { threadType?: string };
  if (extended.threadType === RESIDENT_AGENT_THREAD_TYPE) return true;
  if (extended.threadType === "agent_notice") return true;
  if (thread.id.startsWith("resident-agent-")) return true;
  if (thread.id.startsWith("agent_notice_")) return true;
  if (thread.from.trim() === RESIDENT_AGENT_FROM_NAME) return true;
  return false;
}

/** Group key for collapsing duplicate assistant threads in one inbox scope. */
export function assistantInboxCollapseKey(thread: PersistedInboxThread): string | null {
  const extended = thread as PersistedInboxThread & { threadType?: string };
  if (extended.threadType === RESIDENT_AGENT_THREAD_TYPE || thread.id.startsWith("resident-agent-")) {
    const parsed = parseResidentAgentThreadId(thread.id);
    if (parsed) return `resident_agent:${parsed.residentUserId}`;
  }
  if (extended.threadType === "agent_notice" || thread.id.startsWith("agent_notice_")) {
    const match = thread.id.match(AGENT_NOTICE_ID_RE);
    if (match?.[1]) return `agent_notice:${match[1]}`;
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
