import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isReservedMailboxLocal,
  MAILBOX_LOCAL_PATTERN,
} from "@/lib/manager-assistant-email/assistant-email-address";

const MAILBOX_LOCAL_PREFIX = "assist-";

/** The default-allocation shape only: `assist-<slug>`, unchanged behaviour. */
export function isAssistantMailboxLocal(local: string): boolean {
  const trimmed = local.trim().toLowerCase();
  return trimmed.startsWith(MAILBOX_LOCAL_PREFIX) && MAILBOX_LOCAL_PATTERN.test(trimmed);
}

function slugifyName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
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

export async function allocateAssistantMailboxLocal(
  db: SupabaseClient,
  profile: { fullName: string; email: string },
  tokenSuffix?: string,
): Promise<string> {
  const base = baseMailboxLocalFromProfile(profile.fullName, profile.email);
  const candidates = [base];
  if (tokenSuffix) {
    candidates.push(`${base}-${tokenSuffix.slice(0, 4).toLowerCase()}`);
  }
  for (let i = 2; i <= 9; i += 1) {
    candidates.push(`${base}-${i}`);
  }

  for (const candidate of candidates) {
    if (!isAssistantMailboxLocal(candidate) || isReservedMailboxLocal(candidate)) continue;
    const { data, error } = await db
      .from("manager_assistant_emails")
      .select("manager_user_id")
      .eq("mailbox_local", candidate)
      .maybeSingle();
    if (error) continue;
    if (!data) return candidate;
  }

  const fallback = `${MAILBOX_LOCAL_PREFIX}${(tokenSuffix ?? "x").slice(0, 8).toLowerCase()}`;
  return isAssistantMailboxLocal(fallback) ? fallback : `${MAILBOX_LOCAL_PREFIX}inbox`;
}
