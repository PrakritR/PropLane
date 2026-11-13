import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { CoManagerPermissionId } from "@/lib/co-manager-permissions";
import { sendManagerNoticeEmail } from "@/lib/manager-notice-email.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { readPlatformServiceOwnerId } from "@/lib/service/service-catalog.server";
import { sendTextFromServiceOwner } from "@/lib/service/service-manager.server";
import { isStaffTeamRole } from "@/lib/service/service-mode";
import { SERVICE_ALERT_PHONE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import { resolveWorkspaceNoticeRecipients } from "@/lib/workspace-team-recipients.server";
import { listWorkNumberRecipients } from "@/lib/work-number-recipients.server";

/**
 * Who hears an operations alert about a PropLane-MANAGED (`is_service`) workspace, and how it is paid for.
 *
 * Recipients, all derived on the server (never from a request body):
 *   - the owner's listed "Also notify" phones and emails (`workspace_work_number_recipients`): PropLane's own admin
 *     numbers, whatever the owner added;
 *   - each STAFF seat holder of THIS workspace (a PropLane-issued seat, or an operator role the client granted) whose
 *     role and houses put them on the event (`resolveWorkspaceNoticeRecipients`, the same matrix the Team chat uses:
 *     a Viewer / bookkeeper / maintenance seat hears only what its grants cover), at their VERIFIED account phone and
 *     their account email. A seat on another workspace never reaches this one; the client owner is never a staff seat.
 *
 * Billing: the text is sent from the PropLane line by the platform service owner and paid from THEIR wallet
 * (`sendTextFromServiceOwner`), so an empty client wallet never blocks PropLane's own operations. A self-serve workspace
 * returns null from here and keeps its own wallet. Quiet hours: a listed admin number is texted at once; a seat holder's
 * routine alert is `automated` (held in quiet hours). Opt-out (STOP) is the dispatcher's for everyone.
 */
export type ServiceAlertPhone = {
  phone: string;
  /** The seat holder's account; null for a listed alert phone. */
  userId: string | null;
  label: string;
  sendClass: "transactional" | "automated";
};

export type ServiceAlertEmail = { userId: string | null; toEmail: string | null; label: string };

export type ServiceAlertTargets = {
  workspaceId: string;
  ownerUserId: string;
  workspaceName: string;
  /** Listed alert phones and seat phones, one entry per number. */
  phones: ServiceAlertPhone[];
  /** The seat holders' numbers alone (they already hear Team chat lines and urgent notices on the spine). */
  seatPhones: string[];
  emails: ServiceAlertEmail[];
  /** The listed alert emails alone. */
  listedEmails: ServiceAlertEmail[];
};

type SeatRow = { invitee_user_id?: unknown; workspace_id?: unknown; team_role?: unknown; is_service_seat?: unknown };

/**
 * Pure: which accepted membership rows are STAFF seats of this workspace: a PropLane-issued seat (`is_service_seat`, written only by
 * the admin Service path), or an Admin / Full seat on a workspace PropLane itself owns. A seat the CLIENT wrote on her own workspace is
 * never staff, whatever its role (`serviceSeatVerdict`).
 */
export function staffSeatUserIds(rows: readonly SeatRow[], opts: { workspaceId: string; defaultWorkspaceId: string | null; ownedByServiceOwner?: boolean }): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const id = String(row.invitee_user_id ?? "").trim();
    if (!id) continue;
    const rowWorkspace = String(row.workspace_id ?? "").trim() || opts.defaultWorkspaceId || "";
    if (rowWorkspace !== opts.workspaceId) continue;
    const role = String(row.team_role ?? "").trim();
    if (role === "property_owner") continue;
    if (row.is_service_seat === true || (opts.ownedByServiceOwner === true && (role === "admin" || role === "full") && isStaffTeamRole(role))) out.push(id);
  }
  return [...new Set(out)];
}

/** Pure: merge listed and seat phones into one list, one entry per number (a listed number wins over a seat's). */
export function mergeAlertPhones(listed: readonly ServiceAlertPhone[], seats: readonly ServiceAlertPhone[]): ServiceAlertPhone[] {
  const seen = new Set<string>();
  const out: ServiceAlertPhone[] = [];
  for (const item of [...listed, ...seats]) {
    const key = normalizeE164(item.phone);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, phone: key });
  }
  return out;
}

export async function resolveServiceAlertTargets(
  db: SupabaseClient,
  input: { workspaceId: string; module?: CoManagerPermissionId; propertyId?: string | null; urgent?: boolean },
): Promise<ServiceAlertTargets | null> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) return null;
  const { data: ws, error } = await db.from("portal_workspaces").select("id, name, owner_user_id, is_service, is_default").eq("id", workspaceId).maybeSingle();
  const workspace = ws as { name?: unknown; owner_user_id?: unknown; is_service?: unknown; is_default?: unknown } | null;
  // A self-serve workspace, a missing one or an unreadable read is "not managed": nothing here is ever sent for it.
  if (error || !workspace || workspace.is_service !== true) return null;
  const ownerUserId = String(workspace.owner_user_id ?? "").trim();
  if (!ownerUserId) return null;

  const listed: ServiceAlertPhone[] = [];
  const emails: ServiceAlertEmail[] = [];
  try {
    for (const r of await listWorkNumberRecipients(db, ownerUserId)) {
      if (r.phone) listed.push({ phone: r.phone, userId: null, label: r.label, sendClass: "transactional" });
      if (r.email) emails.push({ userId: null, toEmail: r.email, label: r.label });
    }
  } catch {
    /* the seats below are still told */
  }

  const seatPhones: ServiceAlertPhone[] = [];
  try {
    const { data: defaultRow } = await db.from("portal_workspaces").select("id").eq("owner_user_id", ownerUserId).eq("is_default", true).maybeSingle();
    const defaultWorkspaceId = String((defaultRow as { id?: unknown } | null)?.id ?? "").trim() || null;
    const { data: seatRows, error: seatError } = await db
      .from("account_link_invites")
      .select("invitee_user_id, workspace_id, team_role, is_service_seat")
      .eq("status", "accepted")
      .eq("inviter_user_id", ownerUserId)
      .limit(500);
    if (!seatError) {
      const serviceOwnerId = await readPlatformServiceOwnerId(db).catch(() => null);
      const staffIds = new Set(staffSeatUserIds((seatRows ?? []) as SeatRow[], { workspaceId, defaultWorkspaceId, ownedByServiceOwner: Boolean(serviceOwnerId) && serviceOwnerId === ownerUserId }));
      if (staffIds.size > 0) {
        const roster = await resolveWorkspaceNoticeRecipients(db, {
          ownerUserId,
          workspaceId,
          module: input.module ?? "inbox",
          propertyId: input.propertyId ?? null,
        });
        const chosen = roster.filter((m) => !m.isOwner && staffIds.has(m.userId)).map((m) => m.userId);
        if (chosen.length > 0) {
          const { data: profiles } = await db.from("profiles").select("id, email, phone, phone_verified_at, sms_forward_inbound, full_name").in("id", chosen);
          for (const p of (profiles ?? []) as Array<{ id?: unknown; email?: unknown; phone?: unknown; phone_verified_at?: unknown; sms_forward_inbound?: unknown; full_name?: unknown }>) {
            const userId = String(p.id ?? "");
            const label = String(p.full_name ?? "").trim() || "PropLane team";
            const email = String(p.email ?? "").trim().toLowerCase();
            if (email.includes("@")) emails.push({ userId, toEmail: null, label });
            // A phone counts only when it was verified and forwarding is on: the dispatcher re-checks it as consent.
            if (p.phone_verified_at && p.sms_forward_inbound !== false && String(p.phone ?? "").trim()) {
              seatPhones.push({ phone: String(p.phone), userId, label, sendClass: input.urgent ? "transactional" : "automated" });
            }
          }
        }
      }
    }
  } catch {
    /* an unreadable seat roster narrows to the listed phones: never wider */
  }

  return {
    workspaceId,
    ownerUserId,
    workspaceName: String(workspace.name ?? ""),
    phones: mergeAlertPhones(listed, seatPhones),
    seatPhones: seatPhones.map((p) => normalizeE164(p.phone)).filter((p): p is string => Boolean(p)),
    emails,
    listedEmails: emails.filter((e) => e.userId === null),
  };
}

export type ServiceAlertInput = {
  workspaceId: string;
  module?: CoManagerPermissionId;
  propertyId?: string | null;
  urgent?: boolean;
  /** The finished text, GSM-7 and already redacted by the caller. */
  smsText: string;
  emailSubject: string;
  emailText: string;
  url?: string;
  /** One event = one key; the recipient is appended, so a retry or a second path sends each person once. */
  idempotencyKey: string;
  /** Phones that must NOT get this one (they get a digest of it elsewhere). */
  excludePhones?: readonly string[];
  /**
   * `all` (default): listed alert phones and every seat holder the grants put on the event.
   * `listed_only`: the notice spine's own leg. The seat holders already hear the event as a Team chat line (routine) or
   * their own Assistant notice (urgent), so they are not texted a second time, and a listed phone that IS a seat
   * holder's number is skipped for the same reason: one text per event per person.
   * `seat_emails`: only the staff seats' EMAIL (the Team chat line is a text, so a routine event reaches a seat holder's
   * inbox through this and nowhere else); no text.
   */
  scope?: "all" | "listed_only" | "seat_emails";
};

const keyFor = (key: string, who: string) => createHash("sha256").update(`${key}:${who}`).digest("hex").slice(0, 24);

/** Tell everyone who should hear it about a managed workspace's event. Null = not a managed workspace (nothing sent). */
export async function notifyServiceAlertTargets(
  db: SupabaseClient,
  input: ServiceAlertInput,
): Promise<{ texted: number; emailed: number; refused: string[] } | null> {
  const targets = await resolveServiceAlertTargets(db, input);
  if (!targets) return null;
  const exclude = new Set((input.excludePhones ?? []).map((p) => normalizeE164(p)).filter((p): p is string => Boolean(p)));
  const listedOnly = input.scope === "listed_only";
  if (listedOnly) for (const p of targets.seatPhones) exclude.add(p);
  let texted = 0;
  let emailed = 0;
  const refused: string[] = [];
  const seatEmailsOnly = input.scope === "seat_emails";
  for (const phone of seatEmailsOnly ? [] : targets.phones) {
    if (exclude.has(phone.phone)) continue;
    if (listedOnly && phone.userId !== null) continue;
    try {
      const sent = await sendTextFromServiceOwner(db, {
        toPhone: phone.phone,
        text: input.smsText,
        dedupeKey: `svc-alert:${keyFor(input.idempotencyKey, phone.phone)}`,
        purpose: SERVICE_ALERT_PHONE_SMS_PURPOSE,
        recipientUserId: phone.userId,
        sendClass: phone.sendClass,
      });
      if (sent.ok) texted += 1;
      else refused.push(sent.reason);
    } catch {
      refused.push("send_failed");
    }
  }
  for (const target of listedOnly ? targets.listedEmails : seatEmailsOnly ? targets.emails.filter((e) => e.userId !== null) : targets.emails) {
    try {
      const outcome = await sendManagerNoticeEmail(db, {
        recipientUserId: target.userId ?? `extra:${target.toEmail}`,
        ...(target.toEmail ? { toEmail: target.toEmail } : {}),
        ownerUserId: targets.ownerUserId,
        workspaceId: targets.workspaceId,
        subject: input.emailSubject,
        text: input.emailText,
        url: input.url,
        idempotencyKey: `svc-alert-mail:${keyFor(input.idempotencyKey, target.userId ?? target.toEmail ?? "")}`,
      });
      if (outcome.status === "sent") emailed += 1;
    } catch {
      /* masked: no address or body is logged */
    }
  }
  if (refused.length > 0) {
    console.error("service alert text refused", [...new Set(refused)].join(","));
    await reportServiceSendFailure(db, refused, "workspace alert");
  }
  return { texted, emailed, refused };
}

/** The PropLane service owner's id, for callers that need to know whose wallet a managed alert is billed to. */
export async function serviceAlertPayerUserId(db: SupabaseClient): Promise<string | null> {
  return readPlatformServiceOwnerId(db).catch(() => null);
}

/** Is this workspace PropLane-managed (`is_service`)? False for none, a missing row and an unreadable read. */
export async function isManagedWorkspaceId(db: SupabaseClient, workspaceId: string | null | undefined): Promise<boolean> {
  const id = workspaceId?.trim();
  if (!id) return false;
  const { data, error } = await db.from("portal_workspaces").select("is_service").eq("id", id).maybeSingle();
  return !error && (data as { is_service?: unknown } | null)?.is_service === true;
}

/** Is `actorUserId` the client owner of record of this PropLane-managed workspace (not staff, not an admin)? */
export async function isManagedWorkspaceOwnerActor(db: SupabaseClient, workspaceId: string | null | undefined, actorUserId: string): Promise<boolean> {
  const id = workspaceId?.trim();
  const actor = actorUserId.trim();
  if (!id || !actor) return false;
  const { data, error } = await db.from("portal_workspaces").select("owner_user_id, is_service").eq("id", id).maybeSingle();
  const row = data as { owner_user_id?: unknown; is_service?: unknown } | null;
  return !error && row?.is_service === true && String(row.owner_user_id ?? "").trim() === actor;
}

/** Refusals that are the person's own choice or the clock, not a fault: never reported as a delivery problem. */
const EXPECTED_REFUSALS = new Set(["recipient_opted_out", "opted_out", "quiet_hours", "empty", "duplicate", "protected_account_shielded"]);

/**
 * A PropLane operations text that could not go out (credit, consent, provider, an unreadable line) must never be silent. It raises
 * ONE Attention item for the PropLane service owner per day per reason, in their PropLane Assistant (inbox, push and email: not a text,
 * because the text path is the thing that failed). Best effort; never throws; the reason code is the only detail (no number, no body).
 */
export async function reportServiceSendFailure(db: SupabaseClient, reasons: readonly string[], context: string): Promise<void> {
  try {
    const actionable = [...new Set(reasons.map((r) => r.trim()).filter((r) => r && !EXPECTED_REFUSALS.has(r)))];
    if (actionable.length === 0) return;
    const ownerId = await readPlatformServiceOwnerId(db).catch(() => null);
    if (!ownerId) return;
    const { notifyManagerFromAgent } = await import("@/lib/agent-notify.server");
    const day = new Date().toISOString().slice(0, 10);
    await notifyManagerFromAgent(db, {
      landlordId: ownerId,
      subject: "PropLane alert texts are not going out",
      text: `A ${context} text to PropLane's own phones was refused (${actionable.slice(0, 3).join(", ")}). Check communication credit and the PropLane line in Admin > Service.`,
      threadType: "attention",
      category: "messages",
      notify: { push: true, sms: false },
      idempotencyKey: `svc-send-failure:${day}:${actionable.sort().join("+").slice(0, 80)}`,
      url: "/admin/service",
    });
  } catch {
    console.error("service send failure report failed");
  }
}
