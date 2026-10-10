import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagerAssistantWorkspace } from "@/lib/communication-manager-assistant-thread";
import { workspaceIdForWorkLine } from "@/lib/communication/conversation-key.server";

/**
 * THE answer to "which workspace's PropLane Assistant chat does this write
 * belong to". One Assistant per person per workspace: every writer (in-app
 * notice, SMS mirror, assistant-email mirror, action-event self-send, the
 * list's placeholder) asks here, so the same event can never land in two
 * different `agent_notice_*` rows.
 *
 * Precedence, first hit wins:
 *   1. an explicit `workspaceId` (a UI read may pass the browser's selected
 *      workspace; server paths never read the cookie themselves),
 *   2. the house's workspace (`propertyId`),
 *   3. the work line's workspace (`workLineId`, a `manager_sms_numbers.id`),
 *   4. the user's own default workspace.
 *
 * A candidate whose workspace row cannot be found is skipped, never turned
 * into a suffixed id: a lookup miss must not fork the default workspace's chat.
 * `isDefault` is decided by comparing against the user's REAL default
 * workspace id, so the default workspace always yields the unsuffixed
 * `agent_notice_<uid>` id no matter which rule named it.
 */
export type ManagerAssistantWorkspaceHints = {
  propertyId?: string | null;
  workLineId?: string | null;
  workspaceId?: string | null;
};

export type ResolvedManagerAssistantWorkspace = {
  /** Empty only when the user has no default workspace row yet (the legacy, unsuffixed chat). */
  workspaceId: string;
  isDefault: boolean;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function workspaceRowExists(db: SupabaseClient, workspaceId: string): Promise<boolean> {
  try {
    const { data } = await db.from("portal_workspaces").select("id").eq("id", workspaceId).maybeSingle();
    return Boolean(data?.id);
  } catch {
    return false;
  }
}

async function houseWorkspaceId(db: SupabaseClient, propertyId: string): Promise<string> {
  try {
    const { data } = await db
      .from("manager_property_records")
      .select("workspace_id")
      .eq("id", propertyId)
      .maybeSingle();
    return clean(data?.workspace_id);
  } catch {
    return "";
  }
}

export async function userDefaultWorkspaceId(db: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data } = await db
      .from("portal_workspaces")
      .select("id")
      .eq("owner_user_id", userId)
      .eq("is_default", true)
      .maybeSingle();
    return clean(data?.id);
  } catch {
    return "";
  }
}

export async function resolveManagerAssistantWorkspace(
  db: SupabaseClient,
  userId: string,
  hints: ManagerAssistantWorkspaceHints = {},
): Promise<ResolvedManagerAssistantWorkspace> {
  const defaultId = await userDefaultWorkspaceId(db, clean(userId));
  const candidates: string[] = [];
  const explicit = clean(hints.workspaceId);
  if (explicit) candidates.push(explicit);
  const house = clean(hints.propertyId);
  if (house) candidates.push(await houseWorkspaceId(db, house));
  const line = clean(hints.workLineId);
  if (line) candidates.push((await workspaceIdForWorkLine(db, line)) ?? "");
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === defaultId) return { workspaceId: defaultId, isDefault: true };
    if (await workspaceRowExists(db, candidate)) return { workspaceId: candidate, isDefault: false };
  }
  return { workspaceId: defaultId, isDefault: true };
}

/** The shape `managerAgentNoticeThreadId` takes. */
export function assistantWorkspaceForThreadId(
  resolved: ResolvedManagerAssistantWorkspace,
): ManagerAssistantWorkspace {
  return { id: resolved.workspaceId, isDefault: resolved.isDefault };
}

/** Resolve and shape in one call, for writers that only need the thread id's input. */
export async function resolveManagerAssistantThreadWorkspace(
  db: SupabaseClient,
  userId: string,
  hints: ManagerAssistantWorkspaceHints = {},
): Promise<ManagerAssistantWorkspace> {
  return assistantWorkspaceForThreadId(await resolveManagerAssistantWorkspace(db, userId, hints));
}
