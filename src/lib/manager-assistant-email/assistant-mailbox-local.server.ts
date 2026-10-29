import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isReservedMailboxLocal,
  isValidMailboxLocal,
  MAILBOX_LOCAL_PATTERN,
} from "@/lib/manager-assistant-email/assistant-email-address";

import * as rule from "@/lib/manager-assistant-email/workspace-mailbox-local-rule.mjs";

const MAILBOX_LOCAL_PREFIX = "assist-";

/** The default-allocation shape only: `assist-<slug>`, for profile-based fallbacks. */
export function isAssistantMailboxLocal(local: string): boolean {
  const trimmed = local.trim().toLowerCase();
  return trimmed.startsWith(MAILBOX_LOCAL_PREFIX) && MAILBOX_LOCAL_PATTERN.test(trimmed);
}

function slugifyName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Single `-`, not `-+`: the collapse above never leaves two dashes in a
    // row, and `-+$` rescanned the whole run from every position, so a name of
    // many separators cost quadratic time (CodeQL js/polynomial-redos).
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return slug.length >= 2 ? slug : "";
}

function baseMailboxLocalFromProfile(fullName: string, email: string): string {
  const fromName = slugifyName(fullName);
  if (fromName) return `${MAILBOX_LOCAL_PREFIX}${fromName}`;
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  const fromEmail = slugifyName(local.replace(/\+.*/, ""));
  if (fromEmail) return `${MAILBOX_LOCAL_PREFIX}${fromEmail}`;
  return `${MAILBOX_LOCAL_PREFIX}manager`;
}

function compactLetters(value: string): string {
  return rule.compactLetters(value) as string;
}

/**
 * The one rule for a workspace's work-email local part: the workspace name
 * compacted to letters+digits ("SEATTLE HOMES" -> `seattlehomes`). When that is
 * shorter than 3 characters or reserved, the owner's first name is appended.
 * Returns "" only when nothing usable can be derived. Shared with the backfill
 * script through workspace-mailbox-local-rule.mjs.
 */
export function workspaceMailboxLocalFor(
  workspaceName: string | null | undefined,
  ownerFirstName: string | null | undefined,
): string {
  return rule.workspaceMailboxLocalFor(workspaceName, ownerFirstName) as string;
}

/**
 * The rule for a PropLane-managed (service) workspace: "1. Ambika" -> `ambikahomes`. Falls back to
 * {@link workspaceMailboxLocalFor} when the name gives nothing usable. Shared with the backfill script.
 */
export function serviceWorkspaceMailboxLocalFor(
  workspaceName: string | null | undefined,
  ownerFirstName: string | null | undefined,
): string {
  return rule.serviceWorkspaceMailboxLocalFor(workspaceName, ownerFirstName) as string;
}

/** The address still follows the SERVICE naming rule for `workspaceName` (PropLane minted it, nobody moved it). */
export function mailboxLocalIsDerivedFrom(
  workspaceName: string | null | undefined,
  ownerFirstName: string | null | undefined,
  local: string | null | undefined,
): boolean {
  return rule.mailboxLocalIsDerivedFrom(workspaceName, ownerFirstName, local) as boolean;
}

/** `local` is `base` or `base` plus the allocator's collision suffix. */
export function localFollowsBase(local: string | null | undefined, base: string): boolean {
  return rule.localFollowsBase(local, base) as boolean;
}

export function firstNameOf(fullName: string, email: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  if (compactLetters(first)) return first;
  return (email.trim().split("@")[0] ?? "").replace(/\+.*/, "");
}

/**
 * `<workspace>@domain`, always. A workspace with no usable name at all falls back to the legacy
 * `assist-<owner>` shape, derived from the owner's own name or email local part — never a literal
 * "workspace", which would hand every unnamed workspace the same local part and queue them behind
 * `workspace-2`, `workspace-3`, … with the owner's name silently discarded.
 */
function baseMailboxLocal(
  profile: { fullName: string; email: string },
  workspaceName?: string | null,
  service = false,
): string {
  const first = firstNameOf(profile.fullName, profile.email);
  const derived = service ? serviceWorkspaceMailboxLocalFor(workspaceName, first) : workspaceMailboxLocalFor(workspaceName, first);
  if (derived) return derived;
  return baseMailboxLocalFromProfile(profile.fullName, profile.email);
}

function isAllocatableMailboxLocal(local: string): boolean {
  return isValidMailboxLocal(local) && !isReservedMailboxLocal(local);
}

export async function allocateAssistantMailboxLocal(
  db: SupabaseClient,
  profile: { fullName: string; email: string },
  tokenSuffix?: string,
  workspaceName?: string | null,
  opts: { service?: boolean } = {},
): Promise<string> {
  const base = baseMailboxLocal(profile, workspaceName, opts.service === true);
  const candidates = [base];
  if (tokenSuffix) {
    candidates.push(`${base}-${tokenSuffix.slice(0, 4).toLowerCase()}`);
  }
  for (let i = 2; i <= 9; i += 1) {
    candidates.push(`${base}-${i}`);
  }

  for (const candidate of candidates) {
    if (!isAllocatableMailboxLocal(candidate)) continue;
    const { data, error } = await db
      .from("manager_assistant_emails")
      .select("manager_user_id")
      .eq("mailbox_local", candidate)
      .maybeSingle();
    if (error) continue;
    if (!data) return candidate;
  }

  const fallback = `${MAILBOX_LOCAL_PREFIX}${(tokenSuffix ?? "x").slice(0, 8).toLowerCase()}`;
  return isAllocatableMailboxLocal(fallback) ? fallback : `${MAILBOX_LOCAL_PREFIX}inbox`;
}

/**
 * How long a renamed-away local part stays reserved before another workspace
 * may claim it. `manager_assistant_emails_mailbox_local_uniq` only
 * constrains ACTIVE rows, and a rename overwrites `mailbox_local` on the same
 * row rather than leaving a released one behind, so without this table the
 * old local part is free the instant the rename commits — any other
 * workspace can claim it and start receiving mail senders still address to
 * the previous owner.
 */
export const RELEASED_MAILBOX_ALIAS_DAYS = 30;

const ALIAS_TABLE = "manager_assistant_email_aliases";

export type MailboxLocalAlias = {
  mailboxLocal: string;
  /** The `manager_assistant_emails.id` this alias still routes to (the SAME row — a rename never re-mints one). */
  assistantEmailId: string;
  ownerUserId: string;
  releasedAt: string;
  expiresAt: string;
};

function aliasFromStored(data: Record<string, unknown> | null): MailboxLocalAlias | null {
  if (!data) return null;
  const assistantEmailId = String(data.assistant_email_id ?? "").trim();
  const expiresAt = String(data.expires_at ?? "").trim();
  if (!assistantEmailId || !expiresAt) return null;
  return {
    mailboxLocal: String(data.mailbox_local ?? "").trim().toLowerCase(),
    assistantEmailId,
    ownerUserId: String(data.owner_user_id ?? "").trim(),
    releasedAt: String(data.released_at ?? "").trim(),
    expiresAt,
  };
}

/**
 * The unexpired alias holding `mailboxLocal`, or null if none exists or its
 * cooldown has already lapsed. An expired alias is never claimable-blocking
 * and never routes inbound mail — it behaves exactly as if it never existed.
 */
export async function findActiveMailboxLocalAlias(
  db: SupabaseClient,
  mailboxLocal: string,
): Promise<MailboxLocalAlias | null> {
  const trimmed = mailboxLocal.trim().toLowerCase();
  if (!trimmed) return null;
  const { data, error } = await db
    .from(ALIAS_TABLE)
    .select("mailbox_local, assistant_email_id, owner_user_id, released_at, expires_at")
    .eq("mailbox_local", trimmed)
    .maybeSingle();
  if (error) {
    console.warn("assistant-email alias lookup failed", error.message);
    return null;
  }
  const alias = aliasFromStored(data);
  if (!alias) return null;
  if (new Date(alias.expiresAt).getTime() <= Date.now()) return null;
  return alias;
}

/**
 * Hold a just-renamed-away local part as an alias for
 * {@link RELEASED_MAILBOX_ALIAS_DAYS} so another workspace cannot immediately
 * claim it and start receiving mail still addressed to the previous owner.
 * Upserts on `mailbox_local` so a local released more than once always
 * carries the latest cooldown rather than erroring on the unique primary key.
 */
export async function releaseMailboxLocalAsAlias(
  db: SupabaseClient,
  params: { mailboxLocal: string; assistantEmailId: string; ownerUserId: string },
): Promise<void> {
  const trimmed = params.mailboxLocal.trim().toLowerCase();
  if (!trimmed || !params.assistantEmailId || !params.ownerUserId) return;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RELEASED_MAILBOX_ALIAS_DAYS * 24 * 60 * 60 * 1000);
  const { error } = await db.from(ALIAS_TABLE).upsert(
    {
      mailbox_local: trimmed,
      assistant_email_id: params.assistantEmailId,
      owner_user_id: params.ownerUserId,
      released_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    },
    { onConflict: "mailbox_local" },
  );
  if (error) console.warn("assistant-email alias release failed", error.message);
}

/**
 * Drop the alias for `mailboxLocal` when its own former owner reclaims it by
 * renaming back — a no-op if no alias exists or it belongs to someone else.
 */
export async function reclaimMailboxLocalAlias(
  db: SupabaseClient,
  mailboxLocal: string,
  ownerUserId: string,
): Promise<void> {
  const trimmed = mailboxLocal.trim().toLowerCase();
  if (!trimmed || !ownerUserId) return;
  const { error } = await db
    .from(ALIAS_TABLE)
    .delete()
    .eq("mailbox_local", trimmed)
    .eq("owner_user_id", ownerUserId);
  if (error) console.warn("assistant-email alias reclaim failed", error.message);
}
