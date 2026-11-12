import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { buildInboundAlertText, inboundQuote, type InboundSenderKind } from "@/lib/one-number/inbound-alert";
import { propertyLabel } from "@/lib/one-number/router-lookups.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { notifyServiceAlertTargets, reportServiceSendFailure, resolveServiceAlertTargets } from "@/lib/service/service-alert-targets.server";
import { readServiceManagerSettings, sendTextFromServiceOwner } from "@/lib/service/service-manager.server";
import { SERVICE_ALERT_PHONE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import { phoneKeyOf } from "@/lib/sms/phone-key";
import { locateThreadId } from "@/lib/prospect-spine/locate.server";

/**
 * Every inbound text to a PropLane-managed workspace's number, and to the PropLane line, tells PropLane's own people.
 * "Managed" is decided on the server from the workspace row (`is_service`); a text to anything else never reaches here.
 *
 *   - routed to a managed workspace: the workspace's alert phones and its STAFF seats whose role and houses cover the
 *     event (`notifyServiceAlertTargets`), paid by the platform;
 *   - on the PropLane line with no workspace yet (a stranger, an unassigned lead): PropLane's admin phones only
 *     (`loadPlatformOpsPhones`): an admin number listed on a managed workspace that a verified admin profile holds.
 *
 * The line says who, which house, what they want and carries a portal link; the send is idempotent per message
 * (`inbound-alert:<MessageSid>` plus the recipient). The sender's own phone is never told about its own text. It never
 * throws and never blocks the inbound it follows.
 */
export type InboundAlertInput = {
  /** The workspace the text was routed to, or null on the PropLane line before any routing. */
  workspaceId: string | null;
  /** The line holder, when the text reached a work number. */
  managerId?: string | null;
  fromPhone: string;
  body: string;
  messageSid: string;
  /** The text went to the PropLane line itself (shared or the service owner's number). */
  onPropLaneLine: boolean;
  /** The house the text is about, when the caller already resolved it (the spine's `resolveInboundContext`). */
  propertyId?: string | null;
  /** The finished tag ("5259 Brooklyn Ave NE · Room 4"), when the caller already built it. Wins over the house lookup. */
  houseLabel?: string | null;
  /** Not an SMS ("Listing message", "SpareRoom"): the alert says so instead of "text". */
  channelLabel?: string | null;
  /** The sender's name when no phone is known (a platform inquiry). */
  senderName?: string | null;
  /** The thread the turn lives in; names the reply handle's target. Looked up by phone when absent. */
  threadId?: string | null;
};

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** PropLane's admin phones: listed on a managed workspace AND held by a verified profile that is an admin; plus the verified Service-settings phone. */
export async function loadPlatformOpsPhones(db: SupabaseClient): Promise<string[]> {
  const out = new Set<string>();
  try {
    const { data: workspaces } = await db.from("portal_workspaces").select("owner_user_id").eq("is_service", true).limit(500);
    const owners = [...new Set(((workspaces ?? []) as Row[]).map((r) => str(r.owner_user_id)).filter(Boolean))];
    if (owners.length > 0) {
      const { data: listed } = await db.from("workspace_work_number_recipients").select("phone").in("owner_user_id", owners).not("phone", "is", null).limit(500);
      const phones = [...new Set(((listed ?? []) as Row[]).map((r) => normalizeE164(str(r.phone))).filter((p): p is string => Boolean(p)))];
      if (phones.length > 0) {
        const { data: profiles } = await db.from("profiles").select("id, phone").in("phone", phones).not("phone_verified_at", "is", null).limit(100);
        const ids = [...new Set(((profiles ?? []) as Row[]).map((r) => str(r.id)).filter(Boolean))];
        const { data: admins } = ids.length ? await db.from("profile_roles").select("user_id").eq("role", "admin").in("user_id", ids) : { data: [] };
        const adminIds = new Set(((admins ?? []) as Row[]).map((r) => str(r.user_id)));
        for (const p of (profiles ?? []) as Row[]) {
          if (adminIds.has(str(p.id))) {
            const phone = normalizeE164(str(p.phone));
            if (phone) out.add(phone);
          }
        }
      }
    }
    const settings = await readServiceManagerSettings(db).catch(() => null);
    if (settings?.phoneE164 && settings.verifiedAt) out.add(normalizeE164(settings.phoneE164) ?? settings.phoneE164);
  } catch {
    /* an unreadable roster tells nobody rather than somebody it should not */
  }
  return [...out];
}

async function houseLabel(db: SupabaseClient, propertyId: string | null): Promise<string | null> {
  if (!propertyId) return null;
  try {
    const { data } = await db.from("manager_property_records").select("row_data").eq("id", propertyId).maybeSingle();
    return propertyLabel((data as Row | null)?.row_data) || null;
  } catch {
    return null;
  }
}

type Sender = { kind: InboundSenderKind; name: string | null; propertyId: string | null };

/** Who is texting, as far as PropLane knows: the owner of the workspace, a known contact, a lead on file, or nobody yet. */
async function recognizeSender(db: SupabaseClient, input: { workspaceId: string | null; managerId: string | null; fromPhone: string }): Promise<Sender> {
  const phone = normalizeE164(input.fromPhone) ?? input.fromPhone;
  const empty: Sender = { kind: "unknown", name: null, propertyId: null };
  try {
    if (input.workspaceId) {
      const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", input.workspaceId).maybeSingle();
      const owner = str((ws as Row | null)?.owner_user_id);
      if (owner) {
        const { data: p } = await db.from("profiles").select("full_name, phone").eq("id", owner).maybeSingle();
        if (p && normalizeE164(str((p as Row).phone)) === phone) return { kind: "owner", name: str((p as Row).full_name) || null, propertyId: null };
      }
    }
    const owners = [...new Set([input.managerId ?? ""].filter(Boolean))];
    if (owners.length > 0) {
      const { data: contacts } = await db
        .from("manager_sms_contacts")
        .select("counterparty_role, display_name, contact_email")
        .in("manager_user_id", owners)
        .eq("phone_e164", phone)
        .limit(5);
      const contact = ((contacts ?? []) as Row[])[0];
      if (contact) {
        const role = str(contact.counterparty_role);
        const kind: InboundSenderKind = role === "resident" || role === "vendor" || role === "applicant" || role === "prospect" ? role : "unknown";
        return { kind, name: str(contact.display_name) || null, propertyId: null };
      }
    }
    const { data: lead } = await db.from("sms_unassigned_leads").select("profile, assigned_property_id").eq("phone_key", phoneKeyOf(phone)).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (lead) {
      const profile = ((lead as Row).profile ?? {}) as { offers?: Array<{ propertyId?: string }> };
      const propertyId = str((lead as Row).assigned_property_id) || str(profile.offers?.[0]?.propertyId) || null;
      return { kind: "prospect", name: null, propertyId };
    }
  } catch {
    /* an unreadable lookup degrades to "new contact", never to silence */
  }
  return empty;
}

/** True when this phone is one of PropLane's own people (an admin or a seat holder): their text is not a lead. */
function isOneOf(phone: string, phones: readonly string[]): boolean {
  const p = normalizeE164(phone);
  return p !== null && phones.some((x) => normalizeE164(x) === p);
}

/** Push to every account that should hear it, once per (message, account). Best effort. */
async function pushStaff(db: SupabaseClient, input: { userIds: readonly string[]; title: string; body: string; key: string }): Promise<number> {
  let pushed = 0;
  const { rateLimit } = await import("@/lib/rate-limit");
  const { sendPushToUser } = await import("@/lib/push-notifications.server");
  for (const userId of [...new Set(input.userIds.map(str).filter(Boolean))]) {
    try {
      // One push per (message, person), durable across instances. An unreadable store sends anyway: a double beats a silence.
      const claim = await rateLimit(`inbound-push:${createHash("sha256").update(`${input.key}:${userId}`).digest("hex").slice(0, 32)}`, 1, 10 * 60_000);
      if (!claim.unavailable && !claim.ok) continue;
      const r = await sendPushToUser(userId, { title: input.title, body: input.body, url: "/portal/communication/inbox/unopened" });
      if (r.sent > 0) pushed += 1;
    } catch {
      /* push is best effort; the text and email are the durable alert */
    }
  }
  void db;
  return pushed;
}

/** Profiles that hold one of these verified phones (the listed alert phones that belong to a person with the app). */
async function userIdsForPhones(db: SupabaseClient, phones: readonly string[]): Promise<string[]> {
  const list = [...new Set(phones.map((p) => normalizeE164(p)).filter((p): p is string => Boolean(p)))];
  if (list.length === 0) return [];
  try {
    const { data } = await db.from("profiles").select("id, phone").in("phone", list).not("phone_verified_at", "is", null).limit(100);
    return [...new Set(((data ?? []) as Row[]).map((r) => str(r.id)).filter(Boolean))];
  } catch {
    return [];
  }
}

/** The reply handle for one staff phone, from Package C's relay. A missing or failing relay is no handle, never a failed alert. */
async function replyHandleFor(db: SupabaseClient, input: { staffPhone: string; workspaceId: string; threadId: string | null; counterpartyPhone: string | null }): Promise<string | null> {
  if (!input.threadId || !input.counterpartyPhone) return null;
  try {
    const { mintReplyHandle } = await import("@/lib/manager-sms-commands/index.server");
    return await mintReplyHandle(db, {
      staffPhoneE164: input.staffPhone,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      counterpartyPhoneE164: input.counterpartyPhone,
    });
  } catch {
    return null;
  }
}

export async function alertOpsOfInboundText(db: SupabaseClient, input: InboundAlertInput): Promise<"sent" | "skipped"> {
  try {
    const sid = input.messageSid.trim();
    const from = normalizeE164(input.fromPhone);
    const nameOnly = str(input.senderName);
    if (!sid || (!from && !nameOnly) || !input.body.trim()) return "skipped";
    const sender = from
      ? await recognizeSender(db, { workspaceId: input.workspaceId, managerId: input.managerId ?? null, fromPhone: from })
      : ({ kind: "prospect", name: nameOnly || null, propertyId: null } as Sender);
    const propertyId = str(input.propertyId) || sender.propertyId;
    const house = str(input.houseLabel) || (await houseLabel(db, propertyId));
    // Short on purpose (a text): the portal sends a signed-out person through sign-in and back to the inbox.
    const link = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/communication/inbox/unopened`;
    const phoneForText = from ?? "";
    const baseText = {
      kind: sender.kind, name: sender.name, phone: phoneForText, house, body: input.body, link,
      channelLabel: input.channelLabel ?? null,
    };
    const smsText = buildInboundAlertText(baseText);
    const key = `inbound-alert:${sid}`;
    const pushTitle = `New ${input.channelLabel?.toLowerCase() || "text"}${house ? ` - ${house}` : ""}`;
    const pushBody = `${sender.name || (from ? `***${from.slice(-4)}` : "New contact")}: ${inboundQuote(input.body) || "(no text)"}`.slice(0, 140);

    const targets = input.workspaceId
      ? await resolveServiceAlertTargets(db, { workspaceId: input.workspaceId, module: "inbox", propertyId })
      : null;
    // A managed workspace nobody is listed or seated on is not "skipped": PropLane's own admin phones hear it (below).
    const managedWithNobody = Boolean(targets) && targets!.phones.length === 0 && targets!.emails.length === 0;
    // Not a managed workspace: its own team's spine already covers it (unless the text is on the PropLane line, below).
    if (targets && input.workspaceId && !managedWithNobody) {
      // Their own text is not news to them.
      if (from && isOneOf(from, targets.phones.map((p) => p.phone))) return "skipped";
      const workspaceId = input.workspaceId;
      const threadId = str(input.threadId) || (from ? await locateThreadId(db, { ownerUserId: targets.ownerUserId, workspaceId, phoneE164: from }) : null);
      let texted = 0;
      const refusals: string[] = [];
      // One text per staff phone, each carrying THAT phone's own reply handle. Inbound alerts are transactional: a
      // lead's text never waits for quiet hours to end ("no silent arrivals"; STOP still wins in the dispatcher).
      for (const phone of targets.phones) {
        const handle = await replyHandleFor(db, { staffPhone: phone.phone, workspaceId, threadId, counterpartyPhone: from });
        const text = handle ? buildInboundAlertText({ ...baseText, handle }) : smsText;
        try {
          const r = await sendTextFromServiceOwner(db, {
            toPhone: phone.phone,
            text,
            dedupeKey: `svc-alert:${createHash("sha256").update(`${key}:${phone.phone}`).digest("hex").slice(0, 24)}`,
            purpose: SERVICE_ALERT_PHONE_SMS_PURPOSE,
            recipientUserId: phone.userId,
            sendClass: "transactional",
          });
          if (r.ok) texted += 1;
          else refusals.push(r.reason);
        } catch {
          refusals.push("send_failed");
        }
      }
      // Emails (listed addresses and seat holders) through the shared fan-out; its own text leg is switched off by
      // excluding every phone, because the texts above carry the per-phone handles.
      const out = await notifyServiceAlertTargets(db, {
        workspaceId,
        module: "inbox",
        propertyId,
        smsText,
        emailSubject: `New ${input.channelLabel?.toLowerCase() || "text"}`,
        emailText: smsText.replace(/\n.*$/, ""),
        url: link,
        idempotencyKey: key,
        excludePhones: targets.phones.map((p) => p.phone),
      });
      if (refusals.length > 0) await reportServiceSendFailure(db, refusals, "new-message");
      const pushed = await pushStaff(db, {
        userIds: [
          ...targets.phones.map((p) => p.userId ?? ""),
          ...targets.emails.map((e) => e.userId ?? ""),
          ...(await userIdsForPhones(db, targets.phones.filter((p) => !p.userId).map((p) => p.phone))),
        ],
        title: pushTitle,
        body: pushBody,
        key,
      });
      return texted + (out?.emailed ?? 0) + pushed > 0 ? "sent" : "skipped";
    }

    if (!input.onPropLaneLine && !managedWithNobody) return "skipped";
    // No workspace yet, or a workspace that is not managed: PropLane's admin phones hear it. When nobody is listed the
    // text still tells the platform's own operators rather than "skipped" in silence.
    const phones = await loadPlatformOpsPhones(db);
    if (phones.length === 0 || (from && isOneOf(from, phones))) return "skipped";
    let sent = 0;
    const refusals: string[] = [];
    for (const phone of phones) {
      const r = await sendTextFromServiceOwner(db, {
        toPhone: phone,
        text: smsText,
        dedupeKey: `svc-alert:${createHash("sha256").update(`${key}:${phone}`).digest("hex").slice(0, 24)}`,
        purpose: SERVICE_ALERT_PHONE_SMS_PURPOSE,
        sendClass: "transactional",
      });
      if (r.ok) sent += 1;
      else {
        console.error("inbound alert text refused", r.reason);
        refusals.push(r.reason);
      }
    }
    if (refusals.length > 0) await reportServiceSendFailure(db, refusals, "new-message");
    const opsUsers = await userIdsForPhones(db, phones);
    const pushed = await pushStaff(db, { userIds: opsUsers, title: pushTitle, body: pushBody, key });
    return sent + pushed > 0 ? "sent" : "skipped";
  } catch {
    console.error("inbound alert failed");
    return "skipped";
  }
}
