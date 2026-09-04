/** Client-safe resident assistant thread identifiers — no server imports. */

export const RESIDENT_AGENT_THREAD_TYPE = "resident_agent";

/** Shown as the other party. Never a manager's name. */
export const RESIDENT_AGENT_FROM_NAME = "PropLane Assistant";

const RESIDENT_AGENT_ID_RE =
  /^resident-agent-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/i;

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
