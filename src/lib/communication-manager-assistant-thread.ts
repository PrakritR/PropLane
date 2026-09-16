/**
 * Manager Communication's PropLane Assistant conversation is one thread per
 * (manager, workspace). Legacy rows used `agent_notice_{userId}` and remain
 * the default workspace's chat.
 */

const AGENT_NOTICE_PREFIX = "agent_notice_";

export type ManagerAgentNoticeIdentity = {
  userId: string;
  /** Null on the pre-workspace id; that row is the default workspace's chat. */
  workspaceId: string | null;
};

export type ManagerAssistantWorkspace = {
  id: string;
  isDefault: boolean;
};

export function parseManagerAgentNoticeThreadId(
  threadId: string | null | undefined,
): ManagerAgentNoticeIdentity | null {
  const raw = threadId?.trim() ?? "";
  if (!raw.startsWith(AGENT_NOTICE_PREFIX)) return null;
  const rest = raw.slice(AGENT_NOTICE_PREFIX.length);
  if (!rest) return null;
  const sep = rest.indexOf("__");
  if (sep < 0) return { userId: rest, workspaceId: null };
  const userId = rest.slice(0, sep);
  const workspaceId = rest.slice(sep + 2);
  if (!userId) return null;
  return { userId, workspaceId: workspaceId || null };
}

export function isManagerAgentNoticeThreadId(
  threadId: string | null | undefined,
  ownerUserId?: string | null,
): boolean {
  const parsed = parseManagerAgentNoticeThreadId(threadId);
  if (!parsed) return false;
  const owner = ownerUserId?.trim();
  return owner ? parsed.userId.toLowerCase() === owner.toLowerCase() : true;
}

/** Stable id for this manager in this workspace. Default workspace keeps the legacy form. */
export function managerAgentNoticeThreadId(
  landlordId: string,
  workspace?: ManagerAssistantWorkspace | string | null,
): string {
  const userId = landlordId.trim();
  if (!userId) return "agent_notice_";
  if (!workspace) return `agent_notice_${userId}`;
  if (typeof workspace === "string") {
    const workspaceId = workspace.trim();
    return workspaceId ? `agent_notice_${userId}__${workspaceId}` : `agent_notice_${userId}`;
  }
  if (workspace.isDefault) return `agent_notice_${userId}`;
  const workspaceId = workspace.id.trim();
  return workspaceId ? `agent_notice_${userId}__${workspaceId}` : `agent_notice_${userId}`;
}

/**
 * True when this assistant row is the viewer's chat in the active workspace.
 * A legacy id (no workspace suffix) is the default workspace only.
 */
export function managerAgentNoticeVisibleInWorkspace(
  threadId: string | null | undefined,
  viewerId: string,
  activeWorkspaceId: string | null,
  defaultWorkspaceActive: boolean,
): boolean {
  const parsed = parseManagerAgentNoticeThreadId(threadId);
  if (!parsed) return !activeWorkspaceId || defaultWorkspaceActive;
  if (parsed.userId.toLowerCase() !== viewerId.trim().toLowerCase()) return false;
  if (!activeWorkspaceId) return true;
  if (!parsed.workspaceId) return defaultWorkspaceActive;
  return parsed.workspaceId === activeWorkspaceId;
}

export function managerAgentNoticeCollapseKey(threadId: string): string | null {
  const parsed = parseManagerAgentNoticeThreadId(threadId);
  if (!parsed) return null;
  return parsed.workspaceId
    ? `agent_notice:${parsed.userId}:${parsed.workspaceId}`
    : `agent_notice:${parsed.userId}:default`;
}
