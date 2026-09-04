import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSISTANT_EMAIL_TOKEN_PATTERN,
  assistantEmailAddress,
  generateAssistantEmailToken,
} from "@/lib/manager-assistant-email/assistant-email-address";

export type ManagerAssistantEmailProvisionState = "active" | "released";

export type ManagerAssistantEmailRow = {
  managerUserId: string;
  inboxToken: string;
  address: string;
  provisionState: ManagerAssistantEmailProvisionState;
};

export function isAssistantEmailProvisioningEnabled(): boolean {
  return process.env.ASSISTANT_EMAIL_ENABLED?.trim() !== "0";
}

export async function resolveManagerIdByAssistantEmailToken(
  db: SupabaseClient,
  token: string,
): Promise<string | null> {
  if (!ASSISTANT_EMAIL_TOKEN_PATTERN.test(token)) return null;
  const { data, error } = await db
    .from("manager_assistant_emails")
    .select("manager_user_id, provision_state")
    .eq("inbox_token", token)
    .maybeSingle();
  if (error) {
    console.warn("assistant-email token lookup failed", error.message);
    return null;
  }
  if (!data || data.provision_state !== "active") return null;
  return typeof data.manager_user_id === "string" ? data.manager_user_id : null;
}

export async function loadManagerAssistantEmail(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerAssistantEmailRow | null> {
  const { data, error } = await db
    .from("manager_assistant_emails")
    .select("manager_user_id, inbox_token, provision_state")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error || !data || data.provision_state !== "active") return null;
  const token = String(data.inbox_token ?? "").trim();
  if (!ASSISTANT_EMAIL_TOKEN_PATTERN.test(token)) return null;
  return {
    managerUserId,
    inboxToken: token,
    address: assistantEmailAddress(token),
    provisionState: "active",
  };
}

export async function ensureManagerAssistantEmail(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerAssistantEmailRow> {
  const existing = await loadManagerAssistantEmail(db, managerUserId);
  if (existing) return existing;

  const token = generateAssistantEmailToken();
  const now = new Date().toISOString();
  const { error } = await db.from("manager_assistant_emails").insert({
    manager_user_id: managerUserId,
    inbox_token: token,
    provision_state: "active",
    created_at: now,
    updated_at: now,
  });
  if (error?.code === "23505") {
    const raced = await loadManagerAssistantEmail(db, managerUserId);
    if (raced) return raced;
  }
  if (error) throw new Error(error.message);

  return {
    managerUserId,
    inboxToken: token,
    address: assistantEmailAddress(token),
    provisionState: "active",
  };
}
