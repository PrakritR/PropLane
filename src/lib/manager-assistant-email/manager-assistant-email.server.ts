import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSISTANT_EMAIL_TOKEN_PATTERN,
  assistantEmailAddress,
  assistantMailboxAddress,
  extractAssistantEmailToken,
  extractAssistantMailboxLocal,
  generateAssistantEmailToken,
} from "@/lib/manager-assistant-email/assistant-email-address";
import { allocateAssistantMailboxLocal } from "@/lib/manager-assistant-email/assistant-mailbox-local.server";

export type ManagerAssistantEmailProvisionState = "active" | "released";

export type ManagerAssistantEmailRow = {
  managerUserId: string;
  inboxToken: string;
  mailboxLocal: string | null;
  address: string;
  provisionState: ManagerAssistantEmailProvisionState;
};

type StoredAssistantEmailRow = {
  manager_user_id?: string;
  inbox_token?: string;
  mailbox_local?: string | null;
  provision_state?: string;
};

function publicAddress(token: string, mailboxLocal: string | null): string {
  if (mailboxLocal?.trim()) return assistantMailboxAddress(mailboxLocal);
  return assistantEmailAddress(token);
}

function rowFromStored(
  managerUserId: string,
  data: StoredAssistantEmailRow,
): ManagerAssistantEmailRow | null {
  if (data.provision_state !== "active") return null;
  const token = String(data.inbox_token ?? "").trim();
  if (!ASSISTANT_EMAIL_TOKEN_PATTERN.test(token)) return null;
  const mailboxLocal = String(data.mailbox_local ?? "").trim().toLowerCase() || null;
  return {
    managerUserId,
    inboxToken: token,
    mailboxLocal,
    address: publicAddress(token, mailboxLocal),
    provisionState: "active",
  };
}

async function loadManagerProfile(
  db: SupabaseClient,
  managerUserId: string,
): Promise<{ fullName: string; email: string }> {
  const { data } = await db
    .from("profiles")
    .select("full_name, email")
    .eq("id", managerUserId)
    .maybeSingle();
  return {
    fullName: String(data?.full_name ?? "").trim(),
    email: String(data?.email ?? "").trim().toLowerCase(),
  };
}

export function isAssistantEmailProvisioningEnabled(): boolean {
  return process.env.ASSISTANT_EMAIL_ENABLED?.trim() !== "0";
}

/** False when the manager_assistant_emails table is missing (migration not applied). */
export async function probeAssistantEmailStorageReady(
  db: SupabaseClient,
): Promise<boolean> {
  const { error } = await db.from("manager_assistant_emails").select("manager_user_id").limit(1);
  if (!error) return true;
  const code = String((error as { code?: string }).code ?? "");
  const message = error.message ?? "";
  if (code === "PGRST205" || /manager_assistant_emails/i.test(message)) return false;
  return true;
}

export function isAssistantEmailStorageError(error: { code?: string; message?: string }): boolean {
  const code = String(error.code ?? "");
  const message = error.message ?? "";
  return code === "PGRST205" || /manager_assistant_emails/i.test(message);
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

async function resolveManagerIdByAssistantMailboxLocal(
  db: SupabaseClient,
  mailboxLocal: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("manager_assistant_emails")
    .select("manager_user_id, provision_state")
    .eq("mailbox_local", mailboxLocal.trim().toLowerCase())
    .maybeSingle();
  if (error) {
    console.warn("assistant-email mailbox lookup failed", error.message);
    return null;
  }
  if (!data || data.provision_state !== "active") return null;
  return typeof data.manager_user_id === "string" ? data.manager_user_id : null;
}

/** Resolve manager from any supported assistant To address (legacy plus or assist-*). */
export async function resolveManagerIdByAssistantInboundAddresses(
  db: SupabaseClient,
  addresses: string[],
): Promise<string | null> {
  const token = extractAssistantEmailToken(addresses);
  if (token) return resolveManagerIdByAssistantEmailToken(db, token);
  const mailboxLocal = extractAssistantMailboxLocal(addresses);
  if (mailboxLocal) return resolveManagerIdByAssistantMailboxLocal(db, mailboxLocal);
  return null;
}

/** Backfill a readable assist-* address for legacy plus-only rows. */
export async function upgradeManagerAssistantMailboxLocal(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerAssistantEmailRow | null> {
  const { data, error } = await db
    .from("manager_assistant_emails")
    .select("manager_user_id, inbox_token, mailbox_local, provision_state")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error || !data || data.provision_state !== "active") return null;
  const existingLocal = String(data.mailbox_local ?? "").trim();
  if (existingLocal) return rowFromStored(managerUserId, data);

  const token = String(data.inbox_token ?? "").trim();
  if (!ASSISTANT_EMAIL_TOKEN_PATTERN.test(token)) return null;

  const profile = await loadManagerProfile(db, managerUserId);
  const mailboxLocal = await allocateAssistantMailboxLocal(db, profile, token);
  const now = new Date().toISOString();
  const { error: updateError } = await db
    .from("manager_assistant_emails")
    .update({ mailbox_local: mailboxLocal, updated_at: now })
    .eq("manager_user_id", managerUserId)
    .is("mailbox_local", null);
  if (updateError) {
    console.warn("assistant-email mailbox upgrade failed", updateError.message);
    return rowFromStored(managerUserId, data);
  }

  return rowFromStored(managerUserId, { ...data, mailbox_local: mailboxLocal });
}

export async function loadManagerAssistantEmail(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerAssistantEmailRow | null> {
  const { data, error } = await db
    .from("manager_assistant_emails")
    .select("manager_user_id, inbox_token, mailbox_local, provision_state")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error || !data || data.provision_state !== "active") return null;
  const row = rowFromStored(managerUserId, data);
  if (!row) return null;
  if (!row.mailboxLocal) {
    return (await upgradeManagerAssistantMailboxLocal(db, managerUserId)) ?? row;
  }
  return row;
}

export async function ensureManagerAssistantEmail(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerAssistantEmailRow> {
  const existing = await loadManagerAssistantEmail(db, managerUserId);
  if (existing) return existing;

  const token = generateAssistantEmailToken();
  const profile = await loadManagerProfile(db, managerUserId);
  const mailboxLocal = await allocateAssistantMailboxLocal(db, profile, token);
  const now = new Date().toISOString();
  const { error } = await db.from("manager_assistant_emails").insert({
    manager_user_id: managerUserId,
    inbox_token: token,
    mailbox_local: mailboxLocal,
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
    mailboxLocal,
    address: assistantMailboxAddress(mailboxLocal),
    provisionState: "active",
  };
}
