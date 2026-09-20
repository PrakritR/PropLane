import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSISTANT_EMAIL_TOKEN_PATTERN,
  assistantEmailAddress,
  assistantMailboxAddress,
  extractAssistantEmailToken,
  extractAssistantMailboxLocal,
  generateAssistantEmailToken,
  isReservedMailboxLocal,
  isValidMailboxLocal,
} from "@/lib/manager-assistant-email/assistant-email-address";
import { allocateAssistantMailboxLocal } from "@/lib/manager-assistant-email/assistant-mailbox-local.server";
import {
  isPureCoManagerWorkspace,
  readSelectedWorkspaceIdSafely,
} from "@/lib/sms/manager-workspace-role.server";
import {
  ensureDefaultWorkspaceId,
  listViewerWorkspaces,
  resolveActiveWorkspace,
  type ActiveWorkspace,
} from "@/lib/workspaces/active.server";

export type ManagerAssistantEmailProvisionState = "active" | "released";

export type ManagerAssistantEmailRow = {
  managerUserId: string;
  /** The workspace this address belongs to; null only on a legacy row the migration could not place. */
  workspaceId: string | null;
  inboxToken: string;
  mailboxLocal: string | null;
  address: string;
  provisionState: ManagerAssistantEmailProvisionState;
};

type StoredAssistantEmailRow = {
  manager_user_id?: string;
  workspace_id?: string | null;
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
    workspaceId: String(data.workspace_id ?? "").trim() || null,
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

/** The mailbox an inbound address resolves to: the row's owner and the workspace it is placed in. */
export type AssistantMailboxTarget = { managerUserId: string; workspaceId: string | null };

function mailboxTarget(data: { manager_user_id?: unknown; workspace_id?: unknown } | null): AssistantMailboxTarget | null {
  const managerUserId = typeof data?.manager_user_id === "string" ? data.manager_user_id : "";
  if (!managerUserId) return null;
  return { managerUserId, workspaceId: String(data?.workspace_id ?? "").trim() || null };
}

export async function resolveAssistantMailboxByToken(
  db: SupabaseClient,
  token: string,
): Promise<AssistantMailboxTarget | null> {
  if (!ASSISTANT_EMAIL_TOKEN_PATTERN.test(token)) return null;
  const { data, error } = await db
    .from("manager_assistant_emails")
    .select("manager_user_id, workspace_id, provision_state")
    .eq("inbox_token", token)
    .maybeSingle();
  if (error) {
    console.warn("assistant-email token lookup failed", error.message);
    return null;
  }
  if (!data || data.provision_state !== "active") return null;
  return mailboxTarget(data);
}

export async function resolveManagerIdByAssistantEmailToken(
  db: SupabaseClient,
  token: string,
): Promise<string | null> {
  return (await resolveAssistantMailboxByToken(db, token))?.managerUserId ?? null;
}

async function resolveAssistantMailboxByLocal(
  db: SupabaseClient,
  mailboxLocal: string,
): Promise<AssistantMailboxTarget | null> {
  const { data, error } = await db
    .from("manager_assistant_emails")
    .select("manager_user_id, workspace_id, provision_state")
    .eq("mailbox_local", mailboxLocal.trim().toLowerCase())
    .maybeSingle();
  if (error) {
    console.warn("assistant-email mailbox lookup failed", error.message);
    return null;
  }
  if (!data || data.provision_state !== "active") return null;
  return mailboxTarget(data);
}

/** Resolve the mailbox from any supported assistant To address (legacy plus or assist-*). */
export async function resolveAssistantMailboxByInboundAddresses(
  db: SupabaseClient,
  addresses: string[],
): Promise<AssistantMailboxTarget | null> {
  const token = extractAssistantEmailToken(addresses);
  if (token) return resolveAssistantMailboxByToken(db, token);
  const mailboxLocal = extractAssistantMailboxLocal(addresses);
  if (mailboxLocal) return resolveAssistantMailboxByLocal(db, mailboxLocal);
  return null;
}

/** Resolve manager from any supported assistant To address (legacy plus or assist-*). */
export async function resolveManagerIdByAssistantInboundAddresses(
  db: SupabaseClient,
  addresses: string[],
): Promise<string | null> {
  return (await resolveAssistantMailboxByInboundAddresses(db, addresses))?.managerUserId ?? null;
}

/** Backfill a readable assist-* address for legacy plus-only rows. */
export async function upgradeManagerAssistantMailboxLocal(
  db: SupabaseClient,
  managerUserId: string,
  workspaceId?: string | null,
): Promise<ManagerAssistantEmailRow | null> {
  const { data, error } = await activeRowQuery(db, managerUserId, workspaceId);
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
    .eq("inbox_token", token)
    .is("mailbox_local", null);
  if (updateError) {
    console.warn("assistant-email mailbox upgrade failed", updateError.message);
    return rowFromStored(managerUserId, data);
  }

  return rowFromStored(managerUserId, { ...data, mailbox_local: mailboxLocal });
}

const ROW_SELECT = "manager_user_id, workspace_id, inbox_token, mailbox_local, provision_state";

/**
 * The ACTIVE address row for a workspace. Without a workspace id: the owner's
 * row that is not placed in any workspace — a legacy row — never a row from
 * one of their workspaces, so an old caller cannot pull workspace B's address
 * onto workspace A by mistake.
 */
function activeRowQuery(db: SupabaseClient, managerUserId: string, workspaceId?: string | null) {
  const ws = workspaceId?.trim();
  const q = db.from("manager_assistant_emails").select(ROW_SELECT).eq("provision_state", "active");
  return (ws ? q.eq("workspace_id", ws) : q.eq("manager_user_id", managerUserId).is("workspace_id", null)).maybeSingle();
}

/**
 * The address of ONE workspace (or, with no workspace, the owner's legacy
 * unplaced row). Most callers want `loadWorkspaceAssistantEmail` /
 * `resolveWorkspaceWorkEmail`; the owner-only form is for legacy rows.
 */
export async function loadManagerAssistantEmail(
  db: SupabaseClient,
  managerUserId: string,
  workspaceId?: string | null,
): Promise<ManagerAssistantEmailRow | null> {
  const { data, error } = await activeRowQuery(db, managerUserId, workspaceId);
  if (error || !data || data.provision_state !== "active") return null;
  const row = rowFromStored(managerUserId, data);
  if (!row) return null;
  if (!row.mailboxLocal) {
    return (await upgradeManagerAssistantMailboxLocal(db, managerUserId, workspaceId)) ?? row;
  }
  return row;
}

/** The address a workspace holds: its own row, else the owner's legacy unplaced row (default workspace only). */
export async function loadWorkspaceAssistantEmail(
  db: SupabaseClient,
  workspace: Pick<ActiveWorkspace, "id" | "ownerUserId" | "isDefault">,
): Promise<ManagerAssistantEmailRow | null> {
  const placed = await loadManagerAssistantEmail(db, workspace.ownerUserId, workspace.id);
  if (placed) return placed;
  if (!workspace.isDefault) return null;
  return loadManagerAssistantEmail(db, workspace.ownerUserId, null);
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
  workspaceId: string;
  workspaceName: string;
  /** The viewer owns this workspace (may set its address up); false = shared with them. */
  owned: boolean;
  isDefault: boolean;
  ownerUserId: string;
  ownerName: string | null;
  address: string | null;
};

async function emailsForWorkspaces(db: SupabaseClient, workspaces: ActiveWorkspace[]): Promise<WorkspaceWorkEmail[]> {
  if (workspaces.length === 0) return [];
  const ownerIds = [...new Set(workspaces.map((w) => w.ownerUserId))];
  const [rows, { data: profileRows }] = await Promise.all([
    Promise.all(workspaces.map((w) => loadWorkspaceAssistantEmail(db, w))),
    db.from("profiles").select("id, full_name, email").in("id", ownerIds),
  ]);
  const nameByOwner = new Map(
    (profileRows ?? []).map((p) => [
      String(p.id ?? "").trim(),
      String(p.full_name ?? "").trim() || String(p.email ?? "").trim() || null,
    ]),
  );
  return workspaces.map((w, index) => ({
    workspaceId: w.id,
    workspaceName: w.name,
    owned: w.owned,
    isDefault: w.isDefault,
    ownerUserId: w.ownerUserId,
    ownerName: nameByOwner.get(w.ownerUserId) ?? null,
    address: rows[index]?.address?.trim() || null,
  }));
}

/**
 * The work email of every workspace this account can see, one per workspace.
 *
 * The email twin of `resolveWorkspaceWorkNumbers`, same rule: an address
 * belongs to the workspace it is placed in. An owned workspace without one is
 * listed with a null address so the UI can offer to set it up; a shared
 * workspace shows its owner's address for THAT workspace only. Owned first,
 * default first of those.
 */
export async function resolveWorkspaceWorkEmails(
  db: SupabaseClient,
  userId: string,
): Promise<{ role: "primary" | "co_manager"; emails: WorkspaceWorkEmail[] }> {
  const workspaces = await listViewerWorkspaces(db, userId);
  const pure = await isPureCoManagerWorkspace(db, userId);
  return { role: pure ? ("co_manager" as const) : ("primary" as const), emails: await emailsForWorkspaces(db, workspaces) };
}

/**
 * The work email the viewer is acting from: the ACTIVE workspace's address.
 * `selectedWorkspaceId` overrides the request cookie; outside a request the
 * viewer's own default workspace wins. Null when that workspace has none.
 */
export async function resolveWorkspaceWorkEmail(
  db: SupabaseClient,
  userId: string,
  selectedWorkspaceId?: string | null,
): Promise<WorkspaceWorkEmail | null> {
  const selected = selectedWorkspaceId === undefined ? await readSelectedWorkspaceIdSafely() : selectedWorkspaceId;
  const workspace = await resolveActiveWorkspace(db, userId, selected);
  const [entry] = await emailsForWorkspaces(db, [workspace]);
  return entry ?? null;
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
  /** The workspace the surface is about (a house's workspace). Omitted: the manager's own default workspace. */
  workspaceId?: string | null,
): Promise<string | null> {
  if (!isAssistantEmailChannelEnabled()) return null;
  const workspace = await resolveWorkspaceWorkEmail(db, managerUserId, workspaceId ?? null);
  return workspace?.address?.trim() || null;
}

export class WorkspaceEmailSharedError extends Error {
  readonly code = "workspace_email_shared";
  constructor() {
    super("Your workspace already has a work email. Mail goes out from the address your workspace owner set up.");
    this.name = "WorkspaceEmailSharedError";
  }
}

export class WorkspaceNotOwnedError extends Error {
  readonly code = "workspace_not_owned";
  constructor() {
    super("Only the owner of this workspace can set up its work email.");
    this.name = "WorkspaceNotOwnedError";
  }
}

/**
 * Create a WORKSPACE's work email if it does not have one.
 *
 * One address per workspace, minted only by its owner: a co-manager sends and
 * is reached at the owner's address for that workspace and may never mint a
 * second one — refused here, at the write, so no other caller can quietly
 * hand a co-manager a mailbox. With no workspace named, the actor's own
 * default workspace is meant (the signup and legacy callers).
 */
export async function ensureManagerAssistantEmail(
  db: SupabaseClient,
  managerUserId: string,
  workspace?: Pick<ActiveWorkspace, "id" | "ownerUserId" | "owned" | "isDefault"> | null,
): Promise<ManagerAssistantEmailRow> {
  let target = workspace ?? null;
  if (!target) {
    // A pure co-manager's own default workspace is empty by definition; they
    // reach the owner's address through the shared workspace instead.
    if (await isPureCoManagerWorkspace(db, managerUserId, { throwOnError: true })) {
      throw new WorkspaceEmailSharedError();
    }
    const id = await ensureDefaultWorkspaceId(db, managerUserId);
    target = { id, ownerUserId: managerUserId, owned: true, isDefault: true };
  }
  if (!target.owned || target.ownerUserId !== managerUserId) throw new WorkspaceNotOwnedError();

  const existing = await loadWorkspaceAssistantEmail(db, target);
  if (existing) {
    // A legacy unplaced row answering for the default workspace is adopted
    // by it, so the next reader finds it by workspace like every other row.
    if (!existing.workspaceId) {
      await db
        .from("manager_assistant_emails")
        .update({ workspace_id: target.id, updated_at: new Date().toISOString() })
        .eq("inbox_token", existing.inboxToken)
        .is("workspace_id", null);
      return { ...existing, workspaceId: target.id };
    }
    return existing;
  }

  const token = generateAssistantEmailToken();
  const profile = await loadManagerProfile(db, managerUserId);
  const mailboxLocal = await allocateAssistantMailboxLocal(db, profile, token);
  const now = new Date().toISOString();
  const { error } = await db.from("manager_assistant_emails").insert({
    manager_user_id: managerUserId,
    workspace_id: target.id,
    inbox_token: token,
    mailbox_local: mailboxLocal,
    provision_state: "active",
    created_at: now,
    updated_at: now,
  });
  if (error?.code === "23505") {
    const raced = await loadWorkspaceAssistantEmail(db, target);
    if (raced) return raced;
  }
  if (error) throw new Error(error.message);

  return {
    managerUserId,
    workspaceId: target.id,
    inboxToken: token,
    mailboxLocal,
    address: assistantMailboxAddress(mailboxLocal),
    provisionState: "active",
  };
}

export type MailboxLocalCheckResult =
  | { ok: true; state: "available" | "current" }
  | { ok: false; state: "invalid" | "reserved" | "taken"; message: string };

/**
 * Whether a WORKSPACE could use `local` as its work-email local part.
 *
 * `current` means it is already this workspace's own active local part (a
 * no-op save); any other workspace's active local part is `taken`, exactly
 * like the DB's own unique constraint, but checked ahead of the write so the
 * UI can disable Save before the manager ever submits it.
 */
export async function checkWorkspaceAssistantMailboxLocal(
  db: SupabaseClient,
  workspaceId: string,
  local: string,
): Promise<MailboxLocalCheckResult> {
  const trimmed = local.trim().toLowerCase();
  if (trimmed.length < 3) {
    return { ok: false, state: "invalid", message: "At least 3 characters" };
  }
  if (!isValidMailboxLocal(trimmed)) {
    return { ok: false, state: "invalid", message: "Letters, digits, dots and hyphens only" };
  }
  if (isReservedMailboxLocal(trimmed)) {
    return { ok: false, state: "reserved", message: "That address is reserved." };
  }

  const { data, error } = await db
    .from("manager_assistant_emails")
    .select("workspace_id")
    .eq("mailbox_local", trimmed)
    .eq("provision_state", "active")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { ok: true, state: "available" };

  const holderWorkspaceId = String(data.workspace_id ?? "").trim();
  if (holderWorkspaceId && holderWorkspaceId === workspaceId.trim()) {
    return { ok: true, state: "current" };
  }
  return { ok: false, state: "taken", message: "That address is already in use." };
}

/**
 * Rename a WORKSPACE's work-email local part (e.g. `assist-jane` ->
 * `frontdesk`). Owner-only, same guard `ensureManagerAssistantEmail` uses —
 * which this also calls first, so the workspace is guaranteed to have an
 * active row (adopting a legacy unplaced one for the default workspace) before
 * it is renamed.
 *
 * One address per workspace: mail to the OLD local part stops resolving the
 * instant this commits, because the row's `mailbox_local` is what inbound
 * resolution reads.
 */
export async function setWorkspaceAssistantMailboxLocal(
  db: SupabaseClient,
  managerUserId: string,
  workspace: Pick<ActiveWorkspace, "id" | "ownerUserId" | "owned" | "isDefault">,
  local: string,
): Promise<{ ok: true; address: string } | { ok: false; state: "invalid" | "reserved" | "taken"; message: string }> {
  // Throws WorkspaceNotOwnedError / WorkspaceEmailSharedError for a
  // non-owner, and mints a row first if this workspace somehow has none yet.
  const row = await ensureManagerAssistantEmail(db, managerUserId, workspace);

  const trimmed = local.trim().toLowerCase();
  const check = await checkWorkspaceAssistantMailboxLocal(db, workspace.id, trimmed);
  if (!check.ok) return check;
  if (check.state === "current") {
    return { ok: true, address: row.address };
  }

  const { error } = await db
    .from("manager_assistant_emails")
    .update({ mailbox_local: trimmed, updated_at: new Date().toISOString() })
    .eq("inbox_token", row.inboxToken)
    .eq("provision_state", "active");
  if (error) {
    if (error.code === "23505") {
      return { ok: false, state: "taken", message: "That address is already in use." };
    }
    throw new Error(error.message);
  }
  return { ok: true, address: assistantMailboxAddress(trimmed) };
}
