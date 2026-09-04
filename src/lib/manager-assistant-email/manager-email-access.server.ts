import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveManagerSmsAccess, type ManagerSmsAccess } from "@/lib/sms/manager-sms-access";

export type ManagerEmailInboundIdentity = {
  workNumberOwnerId: string;
  actorUserId: string;
  actorEmail: string;
  access: ManagerSmsAccess;
};

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function profileEmailMatches(
  db: SupabaseClient,
  userId: string,
  fromEmail: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return false;
  const profileEmail = normalizeEmail(String(data.email ?? ""));
  return profileEmail.includes("@") && profileEmail === normalizeEmail(fromEmail);
}

/**
 * Identity gate for the manager email assistant. The To address pins the
 * mailbox owner via `assistant+<token>@…`. From must be that owner's profile
 * email, or a co-manager invitee's profile email with a current assignment.
 */
export async function resolveManagerEmailInboundIdentity(
  db: SupabaseClient,
  args: { workNumberOwnerId: string; fromEmail: string },
): Promise<ManagerEmailInboundIdentity | null> {
  const workNumberOwnerId = args.workNumberOwnerId.trim();
  const fromEmail = normalizeEmail(args.fromEmail);
  if (!workNumberOwnerId || !fromEmail.includes("@")) return null;

  if (await profileEmailMatches(db, workNumberOwnerId, fromEmail)) {
    const access = await resolveManagerSmsAccess(db, {
      actorUserId: workNumberOwnerId,
      workNumberOwnerId,
    });
    if (!access) return null;
    return {
      workNumberOwnerId,
      actorUserId: workNumberOwnerId,
      actorEmail: fromEmail,
      access,
    };
  }

  const { data: inviteRows, error: inviteError } = await db
    .from("account_link_invites")
    .select("invitee_user_id")
    .eq("status", "accepted")
    .eq("inviter_user_id", workNumberOwnerId);
  if (inviteError) return null;

  const inviteeIds = [
    ...new Set(
      (inviteRows ?? [])
        .map((row) => String((row as { invitee_user_id?: string }).invitee_user_id ?? "").trim())
        .filter((id) => id && id !== workNumberOwnerId),
    ),
  ];
  if (inviteeIds.length === 0) return null;

  const { data: profiles, error: profileError } = await db
    .from("profiles")
    .select("id, email")
    .in("id", inviteeIds);
  if (profileError) return null;

  const matches = (profiles ?? []).filter((row) => {
    const email = normalizeEmail(String(row.email ?? ""));
    return email.includes("@") && email === fromEmail;
  });
  if (matches.length !== 1) return null;
  const actorUserId = String(matches[0]?.id ?? "").trim();
  if (!actorUserId) return null;

  const access = await resolveManagerSmsAccess(db, { actorUserId, workNumberOwnerId });
  if (!access || access.mode !== "delegated") return null;
  return {
    workNumberOwnerId,
    actorUserId,
    actorEmail: fromEmail,
    access,
  };
}
