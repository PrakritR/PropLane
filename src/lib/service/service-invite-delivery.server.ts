import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  buildOwnerInviteBody,
  buildServiceTeamInviteBody,
  ownerInviteSubject,
  serviceTeamInviteSubject,
} from "@/lib/co-manager-link-email";
import { inviteLinkUrl } from "@/lib/invite-links/invite-link-model";
import { sharedPortalFromAddress } from "@/lib/manager-outbound-identity.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { sendTextFromServiceOwner } from "@/lib/service/service-manager.server";
import { SERVICE_ALERT_PHONE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";

/**
 * PropLane Service invites to a person with NO account yet. The seat cannot be a row for a user that does not exist,
 * so it is a one-use invite link (the same `/invite/<token>` page every other invite uses: the opener creates their
 * account there and the redeem writes the membership) and this is the email that carries it. A person who already
 * has an account is invited through `notifyCoManagerInviteSent` instead (email, inbox, and a text to a verified
 * phone); a new person has no verified phone, so email is the one channel.
 */

/** The prefix a service invite link's label carries, so the Team list can tell it from a hand-made share link. */
export const SERVICE_INVITE_LABEL_PREFIX = "Service invite · ";

export function serviceInviteLabel(email: string): string {
  return `${SERVICE_INVITE_LABEL_PREFIX}${email.trim().toLowerCase()}`;
}

/** The invited email back out of a link label, or null when the label is not a service invite's. */
export function serviceInviteEmailFromLabel(label: string | null | undefined): string | null {
  const text = String(label ?? "");
  if (!text.startsWith(SERVICE_INVITE_LABEL_PREFIX)) return null;
  const email = text.slice(SERVICE_INVITE_LABEL_PREFIX.length).trim();
  return email.includes("@") ? email : null;
}

export function serviceInviteAcceptUrl(token: string): string {
  return inviteLinkUrl(resolveEmailLinkBaseUrl(), token);
}

export async function sendServiceInviteLinkEmail(
  input: {
    operatorUserId: string;
    to: string;
    token: string;
    workspaceName: string;
    /** Owner copy ("PropLane manages <Workspace> for you") when true; otherwise the teammate copy. */
    ownerInvite: boolean;
    ownerName?: string | null;
    roleLabel: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "Email delivery is not configured (set RESEND_API_KEY)." };
  const acceptUrl = serviceInviteAcceptUrl(input.token);
  const subject = input.ownerInvite ? ownerInviteSubject(input.workspaceName) : serviceTeamInviteSubject(input.workspaceName);
  const text = input.ownerInvite
    ? buildOwnerInviteBody({ ownerName: input.ownerName, workspaceName: input.workspaceName, acceptUrl })
    : buildServiceTeamInviteBody({ workspaceName: input.workspaceName, roleLabel: input.roleLabel, acceptUrl });
  try {
    const res = await postResendEmail({
      apiKey,
      actorUserId: input.operatorUserId,
      payload: {
        from: sharedPortalFromAddress(),
        to: [input.to.trim().toLowerCase()],
        subject,
        text,
      },
      effectSummary: "PropLane Service invite email captured for the test workspace.",
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
 * ONE text about a staff or owner invite, grant or revoke, from the PropLane line and paid by PropLane
 * (`sendTextFromServiceOwner`). It goes only when a phone was given AND the dispatcher's consent rules allow it: for a
 * person with an account the consent is their own verified profile phone (`recipientUserId`); for a number typed beside a
 * brand-new invite there is no consent evidence, so the dispatcher refuses it and the email is the one channel. Never throws;
 * `dedupeKey` makes a retry send nothing a second time.
 */
export async function sendServiceInviteText(
  db: SupabaseClient,
  input: { toPhone: string | null | undefined; text: string; dedupeKey: string; recipientUserId?: string | null },
): Promise<{ texted: boolean; reason?: string }> {
  const to = normalizeE164(String(input.toPhone ?? ""));
  if (!to) return { texted: false, reason: "no_phone" };
  try {
    const sent = await sendTextFromServiceOwner(db, {
      toPhone: to,
      text: input.text,
      dedupeKey: `svc-invite-text:${input.dedupeKey}`,
      purpose: SERVICE_ALERT_PHONE_SMS_PURPOSE,
      recipientUserId: input.recipientUserId ?? null,
      sendClass: "transactional",
    });
    return sent.ok ? { texted: true } : { texted: false, reason: sent.reason };
  } catch {
    return { texted: false, reason: "send_failed" };
  }
}

/** One plain notice email from the shared PropLane address. Never throws. */
export async function sendTeamNoticeEmail(input: {
  actorUserId: string;
  to: string;
  subject: string;
  text: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "Email delivery is not configured (set RESEND_API_KEY)." };
  try {
    const res = await postResendEmail({
      apiKey,
      actorUserId: input.actorUserId,
      payload: { from: sharedPortalFromAddress(), to: [input.to.trim().toLowerCase()], subject: input.subject, text: input.text },
      effectSummary: "PropLane team notice email captured for the test workspace.",
    });
    return res.ok ? { ok: true } : { ok: false, error: "The email could not be sent." };
  } catch {
    return { ok: false, error: "The email could not be sent." };
  }
}
