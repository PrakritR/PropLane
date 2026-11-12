import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Manager SMS commands (design-1112 §3.0). Stub: Package C replaces. */
export type ManagerCommandResult = { handled: false } | { handled: true; reply: string; media?: string[] };

export async function handleManagerSmsCommand(db: SupabaseClient, input: { staffPhoneE164: string; actorUserId: string; workspaceIds: string[]; body: string; messageSid: string; mediaCount: number; onPropLaneLine: boolean }): Promise<ManagerCommandResult> {
  throw new Error("manager-sms-commands: not built");
}

export async function mintReplyHandle(db: SupabaseClient, input: { staffPhoneE164: string; workspaceId: string; threadId: string; counterpartyPhoneE164: string }): Promise<string | null> {
  throw new Error("manager-sms-commands: not built");
}
