import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPlatformOpsPhones } from "@/lib/one-number/inbound-alert.server";
import { isWithinQuietHours } from "@/lib/sms/number-registration-policy";
import { resolveServiceAlertTargets } from "@/lib/service/service-alert-targets.server";
import { sendTextFromServiceOwner } from "@/lib/service/service-manager.server";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { resolveWorkspaceNoticeRecipients } from "@/lib/workspace-team-recipients.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { toGsm7 } from "@/lib/one-number/segments";
import { SERVICE_ALERT_PHONE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import type { ResolvedVoiceCall } from "@/lib/voice/voice-call-routing.server";

/**
 * A live person for a call the assistant cannot finish.
 *
 * The assistant answers the line; when the caller asks for a person, or the assistant cannot answer with confidence (no
 * answer from the tools, something out of scope, an emergency, a caller who is frustrated or keeps being misunderstood), the
 * call is bridged to a human for a short ring. WHO is decided on the server from the routed call, never from anything the
 * caller says, in this order:
 *
 *   1. the covering team member for that house / workspace: a staff seat or co-manager whose role and house grant cover an
 *      inbox event (`resolveWorkspaceNoticeRecipients`, the matrix the alerts use), at a VERIFIED phone with forwarding on;
 *   2. else the workspace owner's verified phone;
 *   3. a PropLane-managed workspace, the PropLane line, or a caller nobody has placed: PropLane's own alert phones
 *      (`resolveServiceAlertTargets` / `loadPlatformOpsPhones`, read from the roster, never typed here).
 *
 * The caller's own number and the dialed line are never a target (that would ring the caller, or loop into this webhook).
 */
export type EscalationReason = "asked_for_person" | "cannot_answer" | "emergency" | "frustrated" | "misunderstood";

export type EscalationTarget = {
  toPhone: string;
  /** First name only, or null: what the caller hears ("connecting you to Ambika"). */
  firstName: string | null;
  via: "covering_member" | "owner" | "platform_admin";
  /** Whose account the number belongs to, when it is a person's own (the dispatcher re-checks consent against it). */
  userId: string | null;
};

type Resolved = Extract<ResolvedVoiceCall, { ok: true }>;
type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const firstNameOf = (full: unknown): string | null => str(full).split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, "") || null;

const FRUSTRATED = /\b(this is (useless|stupid|ridiculous|a joke)|you'?re (not|no) (helping|help|use)|not helpful|useless|are you (a )?(robot|bot|machine)|i('| a)?m (so )?(frustrated|angry|fed up)|nobody (is )?(helping|answering)|this isn'?t working)\b/i;

export function callerIsFrustrated(speech: string): boolean {
  return FRUSTRATED.test(String(speech ?? ""));
}

/** An emergency (gas, fire, flood, a break-in, a lockout) skips quiet hours. */
export function escalationIsUrgent(reason: EscalationReason): boolean {
  return reason === "emergency";
}

/** Outside quiet hours a person may be rung; inside them only an emergency rings, anything else is a call-back. */
export function mayRingNow(reason: EscalationReason, now: Date = new Date()): boolean {
  return escalationIsUrgent(reason) || !isWithinQuietHours(now);
}

async function verifiedPhoneOf(db: SupabaseClient, userId: string): Promise<{ phone: string; firstName: string | null } | null> {
  const { data } = await db.from("profiles").select("phone, phone_verified_at, sms_forward_inbound, full_name").eq("id", userId).maybeSingle();
  const row = data as Row | null;
  const phone = normalizeE164(str(row?.phone));
  if (!row || !phone || !row.phone_verified_at || row.sms_forward_inbound === false) return null;
  return { phone, firstName: firstNameOf(row.full_name) };
}

export async function resolveEscalationTarget(
  db: SupabaseClient,
  args: { resolved: Resolved; callerPhone: string; propertyId?: string | null },
): Promise<EscalationTarget | null> {
  const { resolved } = args;
  const caller = normalizeE164(args.callerPhone);
  const line = normalizeE164(resolved.workNumber);
  const usable = (phone: string | null): phone is string => Boolean(phone) && phone !== caller && phone !== line;
  const platformOwned = resolved.billing.platform !== null;

  // A caller nobody has placed (a stranger, an unclear caller, the PropLane line itself) is PropLane's to answer.
  const unplaced = resolved.route.kind === "ambiguous" || (resolved.route.kind === "prospect" && resolved.route.serviceCatalog === true);

  if (!unplaced && resolved.workspaceId) {
    // PropLane-managed workspace: its covering seats first, then the listed alert phones.
    const managed = platformOwned ? await resolveServiceAlertTargets(db, { workspaceId: resolved.workspaceId, module: "inbox", propertyId: args.propertyId ?? null, urgent: true }).catch(() => null) : null;
    if (managed) {
      const seats = managed.phones.filter((p) => p.userId !== null && usable(normalizeE164(p.phone)));
      const listed = managed.phones.filter((p) => p.userId === null && usable(normalizeE164(p.phone)));
      const pick = seats[0] ?? listed[0];
      if (pick) return { toPhone: normalizeE164(pick.phone) as string, firstName: /^propLane/i.test(pick.label) ? null : firstNameOf(pick.label), via: seats[0] ? "covering_member" : "platform_admin", userId: pick.userId };
    } else {
      const roster = await resolveWorkspaceNoticeRecipients(db, { ownerUserId: resolved.managerId, workspaceId: resolved.workspaceId, module: "inbox", propertyId: args.propertyId ?? null }).catch(() => []);
      for (const member of roster.filter((m) => !m.isOwner)) {
        const found = await verifiedPhoneOf(db, member.userId);
        if (found && usable(found.phone)) return { toPhone: found.phone, firstName: found.firstName, via: "covering_member", userId: member.userId };
      }
      const owner = await verifiedPhoneOf(db, resolved.managerId);
      if (owner && usable(owner.phone)) return { toPhone: owner.phone, firstName: owner.firstName, via: "owner", userId: resolved.managerId };
      if (!platformOwned) return null;
    }
  }

  const admins = (await loadPlatformOpsPhones(db).catch(() => [])).map((p) => normalizeE164(p)).filter(usable);
  return admins[0] ? { toPhone: admins[0], firstName: null, via: "platform_admin", userId: null } : null;
}

/** The one line the target is texted when the call could not be bridged: who, what, and the number to call back. */
export function escalationSummaryText(input: { callerPhone: string; callerKind: string; gist: string; reason: EscalationReason }): string {
  const digits = (normalizeE164(input.callerPhone) ?? input.callerPhone).replace(/\D/g, "");
  const last4 = digits.slice(-4);
  const why: Record<EscalationReason, string> = {
    asked_for_person: "asked for a person",
    cannot_answer: "had a question I could not answer",
    emergency: "reported an emergency",
    frustrated: "was frustrated",
    misunderstood: "was not understood",
  };
  const quote = input.gist.replace(/\s+/g, " ").replace(/https?:\/\/\S+/g, "").trim().slice(0, 70);
  const phone = normalizeE164(input.callerPhone) ?? input.callerPhone;
  return toGsm7(`Call back ${phone}: a ${input.callerKind} (***${last4}) ${why[input.reason]}${quote ? `: "${quote}"` : ""}. They were told you will call.`);
}

/** Text the target the call-back line. Best effort; one per call. */
export async function sendEscalationSummary(
  db: SupabaseClient,
  args: { resolved: Resolved; target: EscalationTarget; callSid: string; text: string; urgent: boolean },
): Promise<boolean> {
  const dedupeKey = `voice-esc:${args.callSid}`;
  try {
    if (args.target.via === "platform_admin") {
      const r = await sendTextFromServiceOwner(db, { toPhone: args.target.toPhone, text: args.text, dedupeKey, purpose: SERVICE_ALERT_PHONE_SMS_PURPOSE, sendClass: args.urgent ? "transactional" : "automated" });
      return r.ok;
    }
    const r = await sendFromManagerWorkNumber({
      managerUserId: args.resolved.managerId,
      ...(args.resolved.workspaceId ? { workspaceId: args.resolved.workspaceId } : {}),
      to: args.target.toPhone,
      text: args.text,
      fromNumber: args.resolved.workNumber,
      source: "automated",
      sendClass: args.urgent ? "transactional" : "automated",
      purpose: "voice_call_summary",
      dedupeKey,
    });
    return r.ok;
  } catch {
    return false;
  }
}
