/**
 * Team chat thread ids. Pure (no server imports) so the visibility rule, the
 * merge script and the UI can all read an id the same way.
 *
 * Current id: `team-thread:<ownerId>:ws:<workspaceId>`, one per workspace.
 * Legacy ids still parse so old rows keep opening until the merge script folds
 * them: `team-thread:<ownerId>:<propertyId>` (per house) and
 * `team-thread:<ownerId>` (house-less).
 */
const TEAM_THREAD_PREFIX = "team-thread:";
const WORKSPACE_SEGMENT = "ws:";

/** The workspace Team chat id for one owner and workspace. */
export function workspaceTeamThreadId(ownerManagerUserId: string, workspaceId: string): string {
  return `${TEAM_THREAD_PREFIX}${ownerManagerUserId.trim()}:${WORKSPACE_SEGMENT}${workspaceId.trim()}`;
}

/** A LEGACY team-thread id: per owner and house; house-less notices shared the owner's plain thread. */
export function teamThreadId(ownerManagerUserId: string, propertyId?: string | null): string {
  const owner = ownerManagerUserId.trim();
  const property = propertyId?.trim() ?? "";
  return property ? `${TEAM_THREAD_PREFIX}${owner}:${property}` : `${TEAM_THREAD_PREFIX}${owner}`;
}

export function isTeamThreadId(id: string): boolean {
  return id.startsWith(TEAM_THREAD_PREFIX);
}

export type ParsedTeamThreadId = {
  ownerManagerUserId: string;
  /** Set for a workspace Team chat; null for a legacy id. */
  workspaceId: string | null;
  /** Set only for a legacy per-house id. */
  propertyId: string | null;
};

/** The owner and workspace (or legacy house) a team-thread id names; `null` for any other id. */
export function parseTeamThreadId(id: string): ParsedTeamThreadId | null {
  if (!isTeamThreadId(id)) return null;
  const rest = id.slice(TEAM_THREAD_PREFIX.length);
  const sep = rest.indexOf(":");
  const owner = (sep < 0 ? rest : rest.slice(0, sep)).trim();
  const tail = sep < 0 ? "" : rest.slice(sep + 1).trim();
  if (!owner) return null;
  if (tail.startsWith(WORKSPACE_SEGMENT)) {
    const workspaceId = tail.slice(WORKSPACE_SEGMENT.length).trim();
    return workspaceId ? { ownerManagerUserId: owner, workspaceId, propertyId: null } : null;
  }
  return { ownerManagerUserId: owner, workspaceId: null, propertyId: tail || null };
}
