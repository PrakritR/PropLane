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
import {
  isPureCoManagerWorkspace,
  listWorkspaceOwnersForCoManager,
} from "@/lib/sms/manager-workspace-role.server";

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

/** Whether THIS DEPLOYMENT can send mail at all, independent of any manager. */
export function isAssistantEmailSendingEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

/**
 * Whether THIS DEPLOYMENT can RECEIVE mail at the work address.
 *
 * The inbound webhook refuses every message on Vercel until
 * `RESEND_INBOUND_WEBHOOK_SECRET` is set (unsigned inbound is allowed only in
 * local dev), so a deployment without it has an address that sends fine and
 * swallows every reply. Sending alone used to be the whole "is it working"
 * test, which is how production advertised addresses nobody could answer to.
 */
export function isAssistantEmailReceivingEnabled(): boolean {
  if (!process.env.VERCEL) return true;
  return Boolean(process.env.RESEND_INBOUND_WEBHOOK_SECRET?.trim());
}

/** Both directions work: the only state in which an address may be shown to somebody else. */
export function isAssistantEmailChannelEnabled(): boolean {
  return isAssistantEmailSendingEnabled() && isAssistantEmailReceivingEnabled();
}

export type WorkspaceWorkEmail = {
  ownerUserId: string;
  ownerName: string | null;
  address: string | null;
};

/**
 * The work email(s) this account sends and is reached at, one per workspace.
 *
 * The email twin of `resolveWorkspaceWorkNumbers`, and the rule is the same:
 * a work email belongs to the workspace, not to whoever requested it. An owner
 * (anyone with a house of their own, or nobody's co-manager) gets their own
 * row. A pure co-manager gets each linked owner's row — never one of their
 * own. A workspace whose owner has not set one up yet is still listed, with a
 * null address, so the UI can say whose job it is to set it up.
 */
export async function resolveWorkspaceWorkEmails(
  db: SupabaseClient,
  userId: string,
): Promise<{ role: "primary" | "co_manager"; emails: WorkspaceWorkEmail[] }> {
  const pure = await isPureCoManagerWorkspace(db, userId);
  const ownerIds = pure
    ? (await listWorkspaceOwnersForCoManager(db, userId)).map((o) => o.ownerUserId)
    : [userId];
  const role = pure ? ("co_manager" as const) : ("primary" as const);
  if (ownerIds.length === 0) return { role, emails: [] };

  const [rows, { data: profileRows }] = await Promise.all([
    Promise.all(ownerIds.map((ownerUserId) => loadManagerAssistantEmail(db, ownerUserId))),
    db.from("profiles").select("id, full_name, email").in("id", ownerIds),
  ]);
  const nameByOwner = new Map(
    (profileRows ?? []).map((p) => [
      String(p.id ?? "").trim(),
      String(p.full_name ?? "").trim() || String(p.email ?? "").trim() || null,
    ]),
  );
  return {
    role,
    emails: ownerIds.map((ownerUserId, index) => ({
      ownerUserId,
      ownerName: nameByOwner.get(ownerUserId) ?? null,
      address: rows[index]?.address?.trim() || null,
    })),
  };
}

/**
 * The one work email this account sends from and is reached at, or null.
 *
 * An owner's own row; for a pure co-manager, the workspace they hold the most
 * houses in (the same tie-break the work number uses).
 */
export async function resolveWorkspaceWorkEmail(
  db: SupabaseClient,
  userId: string,
): Promise<WorkspaceWorkEmail | null> {
  const { emails } = await resolveWorkspaceWorkEmails(db, userId);
  return emails[0] ?? null;
}

/**
 * The work email a manager can actually be REACHED at, or null.
 *
 * The email twin of `resolveActiveManagerSendNumber`, and required for the same
 * reason: an address that cannot answer is worse than none, because the
 * resident writes to it and hears nothing, which reads as being ignored by
 * their manager. Every surface that shows the address to somebody else — the
 * resident contact card, the welcome email, a public listing — goes through
 * this rather than reading the row directly.
 *
 * "Can answer" means both directions: mail goes out AND replies come back in.
 * Resolves to the WORKSPACE address, so a legacy co-manager row never leaks
 * its own address onto a house the owner's address answers for.
 *
 * Deliberately does NOT read billing. Like the number's resolver, this answers
 * "is this channel operational", which is a cheap check the hot paths can make;
 * plan and card questions belong at the request boundary.
 */
export async function resolveActiveManagerWorkEmail(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string | null> {
  if (!isAssistantEmailChannelEnabled()) return null;
  const workspace = await resolveWorkspaceWorkEmail(db, managerUserId);
  return workspace?.address?.trim() || null;
}

export class WorkspaceEmailSharedError extends Error {
  readonly code = "workspace_email_shared";
  constructor() {
    super("Your workspace already has a work email. Mail goes out from the address your workspace owner set up.");
    this.name = "WorkspaceEmailSharedError";
  }
}

/**
 * Create the manager's work email if they do not have one.
 *
 * One address per workspace: a pure co-manager (linked, no houses of their
 * own) sends and is reached at the owner's address, so this refuses to mint a
 * second one for the same workspace — the same rule `provisionManagerNumber`
 * applies to the work number. Refused here, at the write, not only in the
 * route, so no other caller can quietly hand a co-manager their own mailbox.
 */
export async function ensureManagerAssistantEmail(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerAssistantEmailRow> {
  const existing = await loadManagerAssistantEmail(db, managerUserId);
  if (existing) return existing;
  if (await isPureCoManagerWorkspace(db, managerUserId, { throwOnError: true })) {
    throw new WorkspaceEmailSharedError();
  }

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
