import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { ADMIN_INVITE_SUBJECT, buildAdminInviteBody } from "@/lib/co-manager-link-email";
import { inviteLinkUrl } from "@/lib/invite-links/invite-link-model";
import { mintAdminInviteToken, hashInviteLinkToken } from "@/lib/invite-links/invite-links.server";
import { sharedPortalFromAddress } from "@/lib/manager-outbound-identity.server";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { auditAdminTeam, type AdminTeamFailure } from "@/lib/admin-team/admin-team-audit.server";
import {
  ADMIN_INVITE_EXPIRY_DAYS,
  OVERALL_ADMIN_ROLE,
  adminTeamGrantVerdict,
  adminTeamRoleLabel,
  normalizeAdminInviteEmail,
  parseAdminTeamRole,
  parseStoredAdminGrant,
  type AdminTeamActor,
  type StoredAdminGrant,
} from "@/lib/admin-team/admin-team-model";
import { parseInviteAccess, type InviteAccessInput } from "@/lib/co-manager-invite-grant";
import { checkAdminTeamSeatGrant } from "@/lib/service/service-workspaces.server";

/**
 * Minting and emailing an Admin team invite (kind `admin`): one use, bound to one email, seven days. The grant it will
 * make is stored on the row by the inviter here and re-validated at redemption; the opener names nothing.
 */

export type InviteAdminResult = { ok: true; inviteId: string; emailed: true } | AdminTeamFailure;
const fail = (status: number, error: string): AdminTeamFailure => ({ ok: false, status, error });

export type InviteAdminInput = {
  email: unknown;
  role: unknown;
  workspaceIds: unknown;
  /** Houses / module levels exactly as the sheet sent them; re-validated per workspace at redemption. */
  access: InviteAccessInput | null | undefined;
};

async function workspaceNames(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await db.from("portal_workspaces").select("id, name").eq("is_service", true).in("id", ids);
  return new Map(((data ?? []) as { id: string; name: string }[]).map((w) => [String(w.id), String(w.name ?? "").trim()]));
}

async function sendAdminInviteEmail(
  db: SupabaseClient,
  input: { inviterUserId: string; to: string; token: string; roleLabel: string; workspaceNames: string[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "Email delivery is not configured (set RESEND_API_KEY)." };
  const { data } = await db.from("profiles").select("full_name, email").eq("id", input.inviterUserId).maybeSingle();
  const inviterName = (data as { full_name?: string | null; email?: string | null } | null)?.full_name?.trim() || "A PropLane admin";
  const acceptUrl = inviteLinkUrl(resolveEmailLinkBaseUrl(), input.token);
  try {
    const res = await postResendEmail({
      apiKey,
      actorUserId: input.inviterUserId,
      payload: {
        from: sharedPortalFromAddress(),
        to: [input.to],
        subject: ADMIN_INVITE_SUBJECT,
        text: buildAdminInviteBody({
          inviterName,
          roleLabel: input.roleLabel,
          workspaceNames: input.workspaceNames,
          acceptUrl,
          expiresInDays: ADMIN_INVITE_EXPIRY_DAYS,
        }),
      },
      effectSummary: "PropLane admin invite email captured for the test workspace.",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return { ok: false, error: body.message ?? "The email could not be sent." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "The email could not be sent." };
  }
}

/**
 * Invite someone to the admin team. Overall admin is Overall-admin-only (decision 1); a workspace role stays inside the
 * workspaces the inviter manages. The audit row is written before the link exists.
 */
export async function inviteAdminTeamMember(
  db: SupabaseClient,
  inviterUserId: string,
  actor: AdminTeamActor,
  input: InviteAdminInput,
): Promise<InviteAdminResult> {
  const email = normalizeAdminInviteEmail(input.email);
  if (!email) return fail(400, "Enter a valid email address.");
  const role = parseAdminTeamRole(input.role);
  if (!role) return fail(400, "Choose a role.");
  const workspaceIds =
    role === OVERALL_ADMIN_ROLE
      ? []
      : Array.isArray(input.workspaceIds)
        ? [...new Set(input.workspaceIds.map((id) => String(id ?? "").trim()).filter(Boolean))]
        : [];
  const verdict = adminTeamGrantVerdict(actor, { role, workspaceIds });
  if (!verdict.ok) return verdict;
  if (role !== OVERALL_ADMIN_ROLE) {
    // The role / houses are parsed now so a malformed request is refused at the sheet, not at the redeem.
    const parsed = parseInviteAccess({ ...(input.access ?? {}), teamRole: role });
    if (!parsed.ok) return fail(400, parsed.error);
  }
  if (role !== OVERALL_ADMIN_ROLE) {
    // Never above the inviter's own role, never a house outside the workspace: refused now, not when the invitee accepts.
    for (const id of workspaceIds) {
      const checked = await checkAdminTeamSeatGrant(db, inviterUserId, { ...(input.access ?? {}), teamRole: role, id }, { overall: actor.overall });
      if (!checked.ok) return fail(checked.status, checked.error);
    }
  }
  const names = await workspaceNames(db, workspaceIds);
  if (workspaceIds.some((id) => !names.has(id))) return fail(404, "Service workspace not found.");

  const stored: StoredAdminGrant = { role, workspaceIds, access: role === OVERALL_ADMIN_ROLE ? {} : { ...(input.access ?? {}) } };
  const audited = await auditAdminTeam(db, inviterUserId, "admin_team_invite", { inviteeEmail: email, role, workspaceIds });
  if (audited) return audited;

  const token = mintAdminInviteToken();
  const expiresAt = new Date(Date.now() + ADMIN_INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const inserted = await db
    .from("manager_invite_links")
    .insert({
      owner_user_id: inviterUserId,
      kind: "admin",
      token_hash: hashInviteLinkToken(token),
      label: `Admin invite · ${email}`,
      max_uses: 1,
      expires_at: expiresAt,
      invitee_email: email,
      admin_grant: stored,
    })
    .select("id")
    .maybeSingle();
  if (inserted.error || !inserted.data) return fail(503, "Could not create the invite. Please retry.");
  const inviteId = String((inserted.data as { id: unknown }).id);

  const sent = await sendAdminInviteEmail(db, {
    inviterUserId,
    to: email,
    token,
    roleLabel: adminTeamRoleLabel(role),
    workspaceNames: workspaceIds.map((id) => names.get(id) ?? ""),
  });
  if (!sent.ok) {
    // An invite nobody was told about must not sit live.
    await db.from("manager_invite_links").update({ revoked_at: new Date().toISOString() }).eq("id", inviteId);
    return fail(502, `The invite could not be emailed: ${sent.error}`);
  }
  return { ok: true, inviteId, emailed: true };
}

/**
 * Resend: turn the old link off and send a fresh one for the same grant. The actor must be allowed to make that grant
 * now (re-derived), whoever wrote the first link.
 */
export async function resendAdminInvite(
  db: SupabaseClient,
  actorUserId: string,
  actor: AdminTeamActor,
  inviteId: string,
): Promise<InviteAdminResult> {
  const { data, error } = await db
    .from("manager_invite_links")
    .select("id, invitee_email, admin_grant, revoked_at, used_count")
    .eq("id", inviteId)
    .eq("kind", "admin")
    .maybeSingle();
  const row = data as { invitee_email: string | null; admin_grant: unknown; revoked_at: string | null; used_count: number | null } | null;
  if (error || !row || row.revoked_at || (row.used_count ?? 0) > 0) return fail(404, "That invite is no longer waiting.");
  const grant = parseStoredAdminGrant(row.admin_grant);
  if (!grant) return fail(409, "That invite cannot be resent.");
  const verdict = adminTeamGrantVerdict(actor, { role: grant.role, workspaceIds: grant.workspaceIds });
  if (!verdict.ok) return verdict;
  const result = await inviteAdminTeamMember(db, actorUserId, actor, {
    email: row.invitee_email,
    role: grant.role,
    workspaceIds: grant.workspaceIds,
    access: grant.access as InviteAccessInput,
  });
  if (!result.ok) return result;
  await db.from("manager_invite_links").update({ revoked_at: new Date().toISOString() }).eq("id", inviteId).eq("kind", "admin");
  return result;
}
