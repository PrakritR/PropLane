import type { WorkspacePayload } from "./types";

/**
 * The last workspace list this tab received, kept in `sessionStorage` so a full page load (a reload, a hard
 * navigation, a jump between portals) can draw the switcher and the rail at once while `GET /api/workspaces`
 * confirms it in the background. Display only: nothing reads it to scope data or to decide access, and the key
 * matches `clearPortalBrowserCache`, so sign-out and account deletion wipe it.
 *
 * It is bound to the signed-in user id: a payload saved by one account is never handed to another.
 */
export const WORKSPACE_PAYLOAD_CACHE_KEY = "proplane:workspaces:v1";

type Stored = { userId: string; payload: WorkspacePayload };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isPayload(value: unknown): value is WorkspacePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as { workspaces?: unknown; activeWorkspaceId?: unknown };
  return Array.isArray(v.workspaces) && (v.activeWorkspaceId === null || typeof v.activeWorkspaceId === "string");
}

export function readWorkspacePayloadCache(userId: string | null | undefined): WorkspacePayload | null {
  const id = userId?.trim();
  if (!id) return null;
  try {
    const raw = storage()?.getItem(WORKSPACE_PAYLOAD_CACHE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<Stored>;
    if (stored.userId !== id || !isPayload(stored.payload) || stored.payload.workspaces.length === 0) return null;
    return stored.payload;
  } catch {
    return null;
  }
}

export function writeWorkspacePayloadCache(userId: string | null | undefined, payload: WorkspacePayload): void {
  const id = userId?.trim();
  if (!id || payload.workspaces.length === 0) return;
  try {
    storage()?.setItem(WORKSPACE_PAYLOAD_CACHE_KEY, JSON.stringify({ userId: id, payload } satisfies Stored));
  } catch {
    /* a full or blocked storage area just means no warm start */
  }
}
