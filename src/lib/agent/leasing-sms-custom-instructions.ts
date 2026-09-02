import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { LEASING_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { loadAgentCustomInstructions, withAgentCustomInstructions } from "@/lib/agent/user-preferences";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * Lease-text preferences belong to the manager who owns the sending work
 * number. The caller passes that server-resolved owner id, never a prospect
 * supplied id or phone number.
 */
export async function leasingSmsSystemPromptForWorkNumberOwner(db: Db, ownerUserId: string): Promise<string> {
  const instructions = await loadAgentCustomInstructions(db, ownerUserId);
  return withAgentCustomInstructions(LEASING_SMS_AGENT_SYSTEM_PROMPT, instructions);
}
