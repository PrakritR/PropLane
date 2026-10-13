import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DISMISSED_CONTACT_KEYS_PER_CALL,
  normalizeDismissedContactKey,
  validDismissedContactKey,
} from "@/lib/communication/dismissed-contact-keys";

/**
 * Deleted empty chats (`communication_dismissed_contacts`).
 *
 * A "No messages yet" row is built from the resident directory, so deleting one
 * has nothing stored to delete. The dismissal is the stored fact: this viewer,
 * in this workspace, does not want this person listed until a real message
 * exists. Both the viewer and the workspace are resolved by the caller from the
 * session and the workspace cookie, never from a request body.
 */

const TABLE = "communication_dismissed_contacts";

export { DISMISSED_CONTACT_KEYS_PER_CALL, normalizeDismissedContactKey };

/**
 * Distinct, well-formed keys from untrusted input; anything else is dropped.
 * Collects one key PAST the per-call limit and stops, so the caller can refuse
 * an oversized batch instead of saving part of it and reporting all of it.
 */
export function sanitizeDismissedContactKeys(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const keys = new Set<string>();
  for (const value of input) {
    const key = validDismissedContactKey(value);
    if (!key) continue;
    keys.add(key);
    if (keys.size > DISMISSED_CONTACT_KEYS_PER_CALL) break;
  }
  return [...keys];
}

export async function listDismissedContactKeys(
  db: SupabaseClient,
  viewerUserId: string,
  workspaceId: string,
): Promise<string[]> {
  const viewer = viewerUserId.trim();
  const workspace = workspaceId.trim();
  if (!viewer || !workspace) return [];
  const { data, error } = await db
    .from(TABLE)
    .select("contact_key")
    .eq("viewer_user_id", viewer)
    .eq("workspace_id", workspace)
    .limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => normalizeDismissedContactKey((row as { contact_key?: unknown }).contact_key)).filter(Boolean);
}

export async function dismissContactKeys(
  db: SupabaseClient,
  viewerUserId: string,
  workspaceId: string,
  keys: readonly string[],
): Promise<void> {
  const viewer = viewerUserId.trim();
  const workspace = workspaceId.trim();
  if (!viewer || !workspace || keys.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await db.from(TABLE).upsert(
    keys.map((contact_key) => ({ viewer_user_id: viewer, workspace_id: workspace, contact_key, dismissed_at: now })),
    { onConflict: "viewer_user_id,workspace_id,contact_key" },
  );
  if (error) throw new Error(error.message);
}

export async function clearDismissedContactKeys(
  db: SupabaseClient,
  viewerUserId: string,
  workspaceId: string,
  keys: readonly string[],
): Promise<void> {
  const viewer = viewerUserId.trim();
  const workspace = workspaceId.trim();
  if (!viewer || !workspace || keys.length === 0) return;
  const { error } = await db
    .from(TABLE)
    .delete()
    .eq("viewer_user_id", viewer)
    .eq("workspace_id", workspace)
    .in("contact_key", [...keys]);
  if (error) throw new Error(error.message);
}
