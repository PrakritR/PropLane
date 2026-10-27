import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { managerAgentNoticeThreadId } from "@/lib/communication-manager-assistant-thread";

/**
 * The PropLane Assistant chat an admin sees pinned at the top of admin Communication.
 *
 * It is the admin's OWN `agent_notice_<adminId>` row (their default workspace's chat, the id every Assistant writer uses),
 * the one a text from their verified phone to the PropLane line is mirrored into. The read is keyed by BOTH the id built
 * from the viewer's user id and `owner_user_id = viewer`, and nothing in a request names another user: an admin never reads
 * another admin's Assistant thread, however many admins there are.
 */
export type AdminAssistantThread = Record<string, unknown> & { id: string };

export async function loadAdminOwnAssistantThread(
  db: SupabaseClient,
  adminUserId: string,
  deps: { ensure?: (db: SupabaseClient, userId: string) => Promise<unknown> } = {},
): Promise<AdminAssistantThread | null> {
  const userId = adminUserId.trim();
  if (!userId) return null;
  // The default workspace's chat has the unsuffixed id; an admin's text is always mirrored there.
  const threadId = managerAgentNoticeThreadId(userId, { id: "", isDefault: true });
  try {
    const ensure =
      deps.ensure ??
      (async (client: SupabaseClient, id: string) => {
        const { ensureManagerAgentNoticeThread } = await import("@/lib/agent-notify.server");
        return ensureManagerAgentNoticeThread(client, id, { id: "", isDefault: true });
      });
    await ensure(db, userId).catch((error) => console.error("admin assistant thread ensure failed", error instanceof Error ? error.message : "unknown"));
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("id, row_data, owner_user_id")
      .eq("id", threadId)
      .eq("owner_user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const row = (data as { id?: unknown; row_data?: unknown; owner_user_id?: unknown });
    if (String(row.owner_user_id ?? "") !== userId || String(row.id ?? "") !== threadId) return null;
    const rowData = row.row_data && typeof row.row_data === "object" ? (row.row_data as Record<string, unknown>) : {};
    return { ...rowData, id: threadId, ownerUserId: userId, email: "", threadType: "agent_notice" };
  } catch {
    return null;
  }
}
