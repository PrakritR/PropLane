import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  buildSeatGrantedBody,
  buildSeatGrantedText,
  buildSeatRevokedBody,
  buildSeatRevokedText,
  seatGrantedSubject,
  seatRevokedSubject,
} from "@/lib/admin-team/admin-team-notices";
import { sanitizeInviterName } from "@/lib/admin-team/admin-team-model";
import { sendServiceInviteText, sendTeamNoticeEmail } from "@/lib/service/service-invite-delivery.server";

/**
 * Tell a person with an account that their staff seat on managed workspaces was granted or removed: ONE email and at most
 * one text per event, however many workspaces it covers. The text goes only to a verified profile phone that still has
 * forwarding on (the dispatcher re-checks it as consent). Best effort, never throws: the change has already been made and
 * audited, and a notice that fails must not undo it.
 */
type Recipient = { email: string; phone: string | null; userId: string };

async function loadRecipient(db: SupabaseClient, userId: string): Promise<Recipient | null> {
  const { data } = await db.from("profiles").select("email, phone, phone_verified_at, sms_forward_inbound").eq("id", userId).maybeSingle();
  const row = data as { email?: unknown; phone?: unknown; phone_verified_at?: unknown; sms_forward_inbound?: unknown } | null;
  const email = String(row?.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return null;
  const phone = row?.phone_verified_at && row.sms_forward_inbound !== false ? String(row.phone ?? "").trim() || null : null;
  return { email, phone, userId };
}

async function workspaceNames(db: SupabaseClient, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  const { data } = await db.from("portal_workspaces").select("id, name").in("id", unique);
  const byId = new Map(((data ?? []) as { id: string; name: string }[]).map((w) => [String(w.id), String(w.name ?? "").trim()]));
  return unique.map((id) => byId.get(id) ?? "").filter(Boolean);
}

const eventKey = (kind: string, userId: string, ids: readonly string[]) =>
  `${kind}:${userId}:${[...new Set(ids)].sort().join(",")}:${new Date().toISOString().slice(0, 16)}`;

export async function notifySeatGranted(
  db: SupabaseClient,
  input: { actorUserId: string; userId: string; workspaceIds: readonly string[]; roleLabel: string },
): Promise<{ emailed: boolean; texted: boolean }> {
  try {
    if (input.workspaceIds.length === 0) return { emailed: false, texted: false };
    const [recipient, names, actor] = await Promise.all([
      loadRecipient(db, input.userId),
      workspaceNames(db, input.workspaceIds),
      db.from("profiles").select("full_name").eq("id", input.actorUserId).maybeSingle(),
    ]);
    if (!recipient || names.length === 0) return { emailed: false, texted: false };
    const openUrl = `${resolveEmailLinkBaseUrl()}/portal`;
    const inviterName = sanitizeInviterName((actor.data as { full_name?: string | null } | null)?.full_name);
    const email = await sendTeamNoticeEmail({
      actorUserId: input.actorUserId,
      to: recipient.email,
      subject: seatGrantedSubject(names),
      text: buildSeatGrantedBody({ inviterName, roleLabel: input.roleLabel, workspaceNames: names, openUrl }),
    });
    const text = await sendServiceInviteText(db, {
      toPhone: recipient.phone,
      text: buildSeatGrantedText({ workspaceNames: names, openUrl }),
      dedupeKey: eventKey("granted", input.userId, input.workspaceIds),
      recipientUserId: recipient.userId,
    });
    return { emailed: email.ok, texted: text.texted };
  } catch {
    return { emailed: false, texted: false };
  }
}

export async function notifySeatRevoked(
  db: SupabaseClient,
  input: { actorUserId: string; userId: string; workspaceIds: readonly string[] },
): Promise<{ emailed: boolean; texted: boolean }> {
  try {
    if (input.workspaceIds.length === 0) return { emailed: false, texted: false };
    const [recipient, names] = await Promise.all([loadRecipient(db, input.userId), workspaceNames(db, input.workspaceIds)]);
    if (!recipient || names.length === 0) return { emailed: false, texted: false };
    const email = await sendTeamNoticeEmail({
      actorUserId: input.actorUserId,
      to: recipient.email,
      subject: seatRevokedSubject(names),
      text: buildSeatRevokedBody({ workspaceNames: names }),
    });
    const text = await sendServiceInviteText(db, {
      toPhone: recipient.phone,
      text: buildSeatRevokedText({ workspaceNames: names }),
      dedupeKey: eventKey("revoked", input.userId, input.workspaceIds),
      recipientUserId: recipient.userId,
    });
    return { emailed: email.ok, texted: text.texted };
  } catch {
    return { emailed: false, texted: false };
  }
}
