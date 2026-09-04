import { NextResponse, after } from "next/server";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { track } from "@/lib/analytics/posthog";
import {
  findVendorAgentSessionByThread,
  runVendorAgentSessionTurn,
} from "@/lib/agent/vendor-agent.server";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { filterRecipientsBySenderScope } from "@/lib/inbox-recipient-scope";
import { resolveInboxSenderRoleForPortal } from "@/lib/inbox-portal-sender";
import { sendPushToUser } from "@/lib/push-notifications.server";
import { inboxDeepLinkForRole } from "@/lib/platform/parity";
import {
  commitInboxThreadReply,
  deliverPortalMessageThreadSide,
  resolveInboxThreadReplyTarget,
} from "@/lib/portal-inbox-delivery";
import {
  deliverPortalMessageToAdminSharedInbox,
  isPrimaryAdminRecipientEmail,
  mapProfileRoleToAdminInboxSenderRole,
} from "@/lib/admin-shared-inbox.server";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { sendPortalConversationEmails } from "@/lib/portal-email-send.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { canSendResidentOutboundSms, sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import {
  RESIDENT_AGENT_THREAD_TYPE,
  runResidentInboxAgentTurn,
} from "@/lib/agent/resident-inbox-agent.server";
import { runManagerInboxAgentTurn } from "@/lib/agent/manager-inbox-agent.server";
import {
  findThreadByResidentPhone,
  forwardResidentMessageToManagers,
  openClawResidentThread,
} from "@/lib/claw-resident-messaging.server";
import { sendPropLaneSms } from "@/lib/proplane-sms-transport.server";
import { normalizeE164 } from "@/lib/twilio";
import {
  ensureSmsIncludesPortalLink,
  type ResidentSmsLinkKind,
} from "@/lib/claw-resident-links";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  resolveChannels,
  type NotificationCategory,
} from "@/lib/notification-preferences";
import { deliverResidentPropertyManagerChatMessage } from "@/lib/property-manager-inbox-thread.server";
import { fileWorkflowFromInboundMessage } from "@/lib/inbox/inbound-message-workflows.server";
// The recipient's stored chip label must match the sender's optimistic one, so
// both derive it from the storage key with the SAME helper. The local copy this
// route used to keep split the URL rather than `?path=`, so every recipient-side
// attachment was labelled "inbox-attachments".
import { attachmentMetaFromUrls as inboxAttachmentsFromUrls } from "@/lib/inbox-attachments";
import { normalizeInboxAttachmentUrls } from "@/lib/inbox-attachments.server";

export const runtime = "nodejs";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";

const VENDOR_INBOX_SCOPE = "axis_portal_inbox_vendor_v1";

function normalizeEmails(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[;,]/).map((e) => e.trim()).filter(Boolean);
  return [];
}

function normalizeUserIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[;,]/).map((v) => v.trim()).filter(Boolean);
  return [];
}

function scopeForRole(role: string | null | undefined): string {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "manager" || normalized === "pro" || normalized === "admin") return MANAGER_INBOX_SCOPE;
  if (normalized === "vendor") return VENDOR_INBOX_SCOPE;
  return RESIDENT_INBOX_SCOPE;
}

type BroadcastRecipient = { email: string; userId: string | null; role: "resident" | "manager" };

/** Resolve "All management" / "All residents" compose chips to real recipients for the sender's own portfolio. */
async function resolveBroadcastRecipients(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  senderId: string,
  senderEmail: string,
  senderRole: string | null,
  categories: ("management" | "resident")[],
): Promise<BroadcastRecipient[]> {
  const out: BroadcastRecipient[] = [];
  const normalizedRole = String(senderRole ?? "").trim().toLowerCase();

  async function approvedResidentsForManagers(managerIds: string[]) {
    if (managerIds.length === 0) return;
    const { data } = await db
      .from("manager_application_records")
      .select("resident_email, row_data")
      .in("manager_user_id", managerIds);
    for (const row of data ?? []) {
      const rowData = (row.row_data ?? {}) as Record<string, unknown>;
      if (rowData.bucket !== "approved") continue;
      const email = String(row.resident_email ?? rowData.email ?? "").trim().toLowerCase();
      if (email) out.push({ email, userId: null, role: "resident" });
    }
  }

  async function linkedCoManagersForManagers(managerIds: string[]) {
    if (managerIds.length === 0) return;
    const { data } = await db
      .from("portal_pro_relationship_records")
      .select("related_user_id, related_email")
      .in("manager_user_id", managerIds);
    for (const row of data ?? []) {
      const email = String(row.related_email ?? "").trim().toLowerCase();
      if (email) out.push({ email, userId: (row.related_user_id as string | null) ?? null, role: "manager" });
    }
  }

  if (normalizedRole === "manager" || normalizedRole === "pro" || normalizedRole === "admin") {
    if (categories.includes("resident")) await approvedResidentsForManagers([senderId]);
    if (categories.includes("management")) await linkedCoManagersForManagers([senderId]);
    return out;
  }

  // Vendor sender — "management" resolves to the manager(s) who invited/own them.
  if (normalizedRole === "vendor") {
    if (categories.includes("management")) {
      const filter = senderEmail
        ? `vendor_user_id.eq.${senderId},row_data->>email.eq.${senderEmail}`
        : `vendor_user_id.eq.${senderId}`;
      const { data } = await db.from("manager_vendor_records").select("manager_user_id").or(filter);
      const managerIds = [...new Set((data ?? []).map((r) => String(r.manager_user_id ?? "").trim()).filter(Boolean))];
      if (managerIds.length > 0) {
        const { data: mgrProfiles } = await db.from("profiles").select("id, email").in("id", managerIds);
        for (const p of mgrProfiles ?? []) {
          const email = String(p.email ?? "").trim().toLowerCase();
          if (email) out.push({ email, userId: (p.id as string) ?? null, role: "manager" });
        }
      }
    }
    return out;
  }

  // Resident sender — "management" resolves to their property manager plus linked co-managers.
  if (categories.includes("management")) {
    const { data } = await db
      .from("manager_application_records")
      .select("manager_user_id, row_data")
      .ilike("resident_email", senderEmail)
      .limit(1);
    const row = (data ?? [])[0] as { manager_user_id: string | null; row_data: unknown } | undefined;
    const rowData = (row?.row_data ?? {}) as Record<string, unknown>;
    const managerUserId = rowData.bucket === "approved" ? row?.manager_user_id ?? null : null;
    if (managerUserId) {
      const { data: mgrProfile } = await db.from("profiles").select("id, email").eq("id", managerUserId).maybeSingle();
      const mgrEmail = String(mgrProfile?.email ?? "").trim().toLowerCase();
      if (mgrEmail) out.push({ email: mgrEmail, userId: managerUserId, role: "manager" });
      await linkedCoManagersForManagers([managerUserId]);
    }
  }
  return out;
}

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });

    if (
      !rateLimit(`send-inbox:user:${user.id}`, 30, 60_000).ok ||
      !rateLimit(`send-inbox:ip:${clientIpFrom(req)}`, 60, 60_000).ok
    ) {
      return NextResponse.json({ ok: false, error: "Too many messages. Please slow down." }, { status: 429 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      fromName?: string;
      fromEmail?: string;
      toEmails?: unknown;
      toUserIds?: unknown;
      toBroadcast?: unknown;
      subject?: string;
      text?: string;
      threadId?: string;
      deliverToPortalInbox?: boolean;
      deliverViaEmail?: boolean;
      deliverViaSms?: boolean;
      propertyId?: string;
      propertyTitle?: string;
      managerUserId?: string;
      /** When set with a single manager recipient, also notify linked co-managers with inbox access. */
      fanOutPropertyInbox?: boolean;
      /** Gate email/SMS per recipient's saved preference for this category (inbox always on). */
      eventCategory?: string;
      attachmentUrls?: unknown;
      senderPortal?: string;
    };

    const threadId = String(body.threadId ?? "").trim();
    const senderEmail = String(user.email ?? body.fromEmail ?? "portal@example.com").trim().toLowerCase();
    const subject = String(body.subject ?? "").trim();
    const rawText = String(body.text ?? "").trim();
    const attachmentUrls = normalizeInboxAttachmentUrls(
      Array.isArray(body.attachmentUrls) ? body.attachmentUrls : [],
      user.id,
    );
    const attachmentNote = attachmentUrls.length
      ? "\n\nAttachments:\n" + attachmentUrls.join("\n")
      : "";
    const text = (rawText + attachmentNote).trim() || (attachmentUrls.length ? "(attachment)" : "");
    const fromName = String(body.fromName ?? "PropLane Portal").trim();
    const deliverToPortalInbox = body.deliverToPortalInbox !== false;
    const deliverViaEmail = body.deliverViaEmail !== false;
    const deliverViaSms = body.deliverViaSms === true;
    // When a category is provided, email/SMS are gated PER RECIPIENT by their
    // saved notification preferences (this route is a parallel implementation of
    // deliverPortalInboxMessage and must honor the same matrix). Without one, the
    // legacy uniform booleans above apply to everyone.
    const eventCategory: NotificationCategory | null =
      typeof body.eventCategory === "string" &&
      (NOTIFICATION_CATEGORIES as string[]).includes(body.eventCategory)
        ? (body.eventCategory as NotificationCategory)
        : null;

    if (!subject || (!rawText && attachmentUrls.length === 0)) {
      return NextResponse.json({ ok: false, error: "subject and text are required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();

    // Resolving the thread authorizes the sender against it but writes NOTHING
    // yet: the recipient-scope gate below can still refuse this send with a 403,
    // and a refused message must never appear in the thread store. The commit is
    // deferred until that gate passes. See `resolveInboxThreadReplyTarget`.
    const replyTarget = threadId
      ? await resolveInboxThreadReplyTarget(db, { threadId, senderUserId: user.id, senderEmail })
      : null;
    const replyBody = { fromName, text, attachments: inboxAttachmentsFromUrls(attachmentUrls) };

    if (replyTarget) {
      // A vendor replying in their agent thread talks to the agent, not to a
      // human recipient — run the turn after the response and skip the normal
      // fan-out. Only the thread OWNER (the vendor) triggers it. There is no
      // recipient to scope-check here, so this branch commits its own reply.
      if (replyTarget.threadType === "vendor_agent" && replyTarget.ownerUserId === user.id) {
        await commitInboxThreadReply(db, replyTarget, replyBody);
        const session = await findVendorAgentSessionByThread(db, threadId);
        if (session) {
          const turnTask = () =>
            runVendorAgentSessionTurn(db, session, text, "inbox").catch((e) =>
              console.error("vendor-agent inbox turn failed", e),
            );
          try {
            after(turnTask);
          } catch {
            void turnTask();
          }
        }
        return NextResponse.json({ ok: true, agentHandled: true });
      }

      // Same shape for a resident's assistant thread. The other party here is
      // PropLane itself, so there is no human recipient to scope-check and this
      // branch commits its own reply. The turn runs AFTER the response so a slow
      // model never delays the resident's own message from appearing.
      if (replyTarget.threadType === RESIDENT_AGENT_THREAD_TYPE && replyTarget.ownerUserId === user.id) {
        await commitInboxThreadReply(db, replyTarget, { ...replyBody, outbound: true });
        const turnTask = () =>
          runResidentInboxAgentTurn(db, replyTarget, user.id, senderEmail, text)
            .then((outcome) => {
              // A turn that declines to reply is the interesting case and is
              // otherwise invisible: no throw, no message, nothing in the log.
              if (!outcome.replied) {
                console.error("resident-agent inbox turn did not reply", outcome.reason);
              }
            })
            .catch((e) => console.error("resident-agent inbox turn failed", e));
        try {
          after(turnTask);
        } catch {
          void turnTask();
        }
        return NextResponse.json({ ok: true, agentHandled: true });
      }

      if (replyTarget.threadType === "agent_notice" && replyTarget.ownerUserId === user.id) {
        await commitInboxThreadReply(db, replyTarget, { ...replyBody, outbound: true });
        const turnTask = () =>
          runManagerInboxAgentTurn(db, replyTarget, user.id, text)
            .then((outcome) => {
              if (!outcome.replied) {
                console.error("manager-agent inbox turn did not reply", outcome.reason);
              }
            })
            .catch((e) => console.error("manager-agent inbox turn failed", e));
        try {
          after(turnTask);
        } catch {
          void turnTask();
        }
        return NextResponse.json({ ok: true, agentHandled: true });
      }
    }

    let toUserIds = normalizeUserIds(body.toUserIds);
    const senderIsAdmin = await isAdminUser(user.id);
    const { data: senderProfile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const portalParam = String(body.senderPortal ?? "").trim().toLowerCase();
    const senderPortal =
      portalParam === "manager" || portalParam === "vendor" ? portalParam : "resident";
    const senderRole = await resolveInboxSenderRoleForPortal(db, {
      userId: user.id,
      legacyRole: senderProfile?.role ?? null,
      portal: senderPortal,
      isAdmin: senderIsAdmin,
    });

    const propertyId = String(body.propertyId ?? "").trim();
    if (propertyId && body.fanOutPropertyInbox !== false && toUserIds.length === 1) {
      toUserIds = await resolvePropertyScopedManagerRecipientIds(db, {
        ownerManagerUserId: toUserIds[0]!,
        propertyId,
        channel: "inbox",
      });
    }

    const recipientsByEmail = new Map<
      string,
      { email: string; userId: string | null; role: string | null; scope: string }
    >();

    const toEmailsNormalized = normalizeEmails(body.toEmails)
      .filter((e) => e.includes("@"))
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e !== senderEmail && !recipientsByEmail.has(e));

    if (toEmailsNormalized.length > 0) {
      const { data: emailProfiles } = await db
        .from("profiles")
        .select("id, email, role")
        .in("email", toEmailsNormalized);
      const profileByEmail = new Map(
        (emailProfiles ?? []).map((p) => [String(p.email ?? "").trim().toLowerCase(), p]),
      );
      for (const email of toEmailsNormalized) {
        if (recipientsByEmail.has(email)) continue;
        // No matching profile (e.g. not yet signed up) — best-effort resident
        // scope so the row still shows up if/when they sign in by that email.
        const profile = profileByEmail.get(email);
        const role = profile ? String(profile.role ?? "").trim().toLowerCase() || null : null;
        recipientsByEmail.set(email, {
          email,
          userId: profile?.id ?? null,
          role,
          scope: scopeForRole(role),
        });
      }
    }

    if (toUserIds.length > 0) {
      const { data: recipientProfiles } = await db
        .from("profiles")
        .select("id, email, role")
        .in("id", toUserIds);
      for (const profile of recipientProfiles ?? []) {
        const email = String(profile.email ?? "").trim().toLowerCase();
        if (!email || email === senderEmail) continue;
        const role = String(profile.role ?? "").trim().toLowerCase() || null;
        recipientsByEmail.set(email, {
          email,
          userId: profile.id ?? null,
          role,
          scope: scopeForRole(role),
        });
      }
    }

    const broadcastCategories = (Array.isArray(body.toBroadcast) ? body.toBroadcast : [])
      .filter((c): c is "management" | "resident" => c === "management" || c === "resident");
    if (broadcastCategories.length > 0) {
      const broadcastRecipients = await resolveBroadcastRecipients(db, user.id, senderEmail, senderRole, broadcastCategories);
      for (const r of broadcastRecipients) {
        if (r.email === senderEmail || recipientsByEmail.has(r.email)) continue;
        recipientsByEmail.set(r.email, { email: r.email, userId: r.userId, role: r.role, scope: scopeForRole(r.role) });
      }
    }

    // Enforce role scope on the SERVER (the compose UI only hides people; it is
    // not a boundary). Residents may message only their own manager(s)/owner(s);
    // managers may message only their own residents/co-managers; both may reach
    // Axis admin ops. Admins are unrestricted. Broadcast recipients above are
    // already resolved from the sender's own relationships, so they pass through;
    // this meaningfully restricts arbitrary toEmails/toUserIds. See
    // src/lib/inbox-recipient-scope.ts for the authoritative rules.
    const senderActsAsAdmin = senderIsAdmin || senderRole === "admin";

    let recipients = [...recipientsByEmail.values()];
    if (!senderActsAsAdmin) {
      const { allowed } = await filterRecipientsBySenderScope(
        db,
        { id: user.id, email: senderEmail, role: senderRole, isAdmin: false },
        recipients,
      );
      if (allowed.length === 0) {
        return NextResponse.json(
          { ok: false, error: "You can only message people connected to your account." },
          { status: 403 },
        );
      }
      recipients = allowed;
    }

    // Every gate is now clear, so the reply may finally land in its thread. A
    // send refused above returns before this line and writes nothing.
    if (replyTarget) await commitInboxThreadReply(db, replyTarget, replyBody);

    // PRP-109: a resident who TEXTS "the sink is leaking" has had a work order
    // opened for them since the Claw work; the same sentence typed here did
    // nothing, so the channel they happened to use decided whether their
    // manager heard about it. Same rule now, one shared decision.
    //
    // Deferred with `after()` and best-effort by contract: the message is
    // already delivered above, and filing must never be able to fail a send.
    // The manager identity comes from the recipient the scope filter already
    // authorized, never from anything written in the body.
    // At most once per request. A resident property chat satisfies BOTH the
    // single-recipient case below and the explicit-manager case further down;
    // the creators would dedupe the second filing, but asking them to is waste,
    // not a design.
    let workflowQueued = false;
    const queueResidentWorkflow = (managerUserId: string, residentName?: string) => {
      if (workflowQueued || !managerUserId || senderRole !== "resident") return;
      workflowQueued = true;
      after(
        fileWorkflowFromInboundMessage({
          managerUserId,
          residentEmail: senderEmail,
          residentUserId: user.id,
          residentName: residentName ?? fromName,
          text,
          channel: "portal",
        }).then(() => undefined),
      );
    };

    // Only for a reply that just COMMITTED above. The no-thread paths are
    // handled where they deliver — queuing here would file a work order for a
    // property-chat message that the ownership check further down can still
    // refuse with a 403.
    //
    // One recipient, so "the manager" is unambiguous; admin ops is not a
    // manager and must never have a work order filed against it.
    if (
      replyTarget &&
      senderRole === "resident" &&
      recipients.length === 1 &&
      recipients[0]!.userId &&
      !isPrimaryAdminRecipientEmail(recipients[0]!.email)
    ) {
      queueResidentWorkflow(recipients[0]!.userId!);
    }

    // Per-recipient channel resolution (category mode) mirrors core delivery:
    // email/SMS follow each recipient's saved prefs; account-less (no userId)
    // recipients get the category-default email and never SMS.
    const channelByEmail = new Map<string, { inbox: boolean; email: boolean; sms: boolean }>();
    if (eventCategory) {
      const recipientUserIds = recipients
        .map((r) => r.userId)
        .filter((id): id is string => Boolean(id));
      const phoneById = new Map<
        string,
        {
          phone: string | null;
          phone_verified_at: string | null;
          role: string | null;
          sms_from_number: string | null;
          sms_forward_inbound: boolean | null;
        }
      >();
      if (recipientUserIds.length) {
        const { data: recProfiles } = await db
          .from("profiles")
          .select("id, phone, phone_verified_at, role, sms_from_number, sms_forward_inbound")
          .in("id", recipientUserIds);
        for (const p of recProfiles ?? []) {
          phoneById.set(String(p.id), {
            phone: (p.phone as string | null) ?? null,
            phone_verified_at: (p.phone_verified_at as string | null) ?? null,
            role: (p.role as string | null) ?? null,
            sms_from_number: (p.sms_from_number as string | null) ?? null,
            sms_forward_inbound: (p.sms_forward_inbound as boolean | null) ?? null,
          });
        }
      }
      for (const r of recipients) {
        if (r.userId) {
          const ch = await resolveChannels(db, r.userId, eventCategory, phoneById.get(r.userId) ?? null);
          channelByEmail.set(r.email, { inbox: ch.inbox, email: ch.email, sms: ch.sms });
        } else {
          channelByEmail.set(r.email, {
            inbox: true,
            email: DEFAULT_NOTIFICATION_PREFERENCES[eventCategory].email,
            sms: false,
          });
        }
      }
    }
    const emailWanted = (email: string): boolean =>
      eventCategory ? channelByEmail.get(email)?.email === true : deliverViaEmail;
    const anySmsWanted = eventCategory
      ? recipients.some((r) => channelByEmail.get(r.email)?.sms === true)
      : deliverViaSms;

    // All non-sandbox recipient emails — sandbox accounts skip Resend.
    // NOTE: endsWith("@axis.local") alone is wrong for "@test.proplane.local".
    const toEmails = recipients
      .map((recipient) => recipient.email)
      .filter((email) => !isPortalSandboxEmail(email));
    // The actual email SEND list: category mode → recipients whose email channel
    // is on; legacy → all real recipients when deliverViaEmail.
    const emailToSend = recipients
      .filter((recipient) => emailWanted(recipient.email))
      .map((recipient) => recipient.email)
      .filter((email) => !isPortalSandboxEmail(email));

    // Deliver to portal inbox for all recipients (including @axis.local demo emails)
    let propertyThreadId: string | null = null;
    const propertyTitleInput = String(body.propertyTitle ?? "").trim();
    const residentPropertyChat =
      senderRole === "resident" &&
      propertyId &&
      !threadId &&
      deliverToPortalInbox &&
      broadcastCategories.length === 0 &&
      recipients.length === 1 &&
      !isPrimaryAdminRecipientEmail(recipients[0]!.email);

    if (residentPropertyChat) {
      const { data: propRow } = await db
        .from("manager_property_records")
        .select("manager_user_id, property_data, row_data")
        .eq("id", propertyId)
        .maybeSingle();
      const ownerManagerId = String(propRow?.manager_user_id ?? "").trim();
      if (!ownerManagerId) {
        return NextResponse.json({ ok: false, error: "Property not found." }, { status: 404 });
      }
      const propertyManagerIds = await resolvePropertyScopedManagerRecipientIds(db, {
        ownerManagerUserId: ownerManagerId,
        propertyId,
        channel: "inbox",
      });
      const recipientUserId = recipients[0]!.userId;
      if (!recipientUserId || !propertyManagerIds.includes(recipientUserId)) {
        return NextResponse.json(
          { ok: false, error: "You can only message people connected to your account." },
          { status: 403 },
        );
      }
      const managerUserIdForProperty = recipientUserId;

      let propertyTitle = propertyTitleInput;
      if (!propertyTitle) {
        const pd = (propRow?.property_data ?? null) as { title?: string } | null;
        const rd = (propRow?.row_data ?? null) as { title?: string } | null;
        propertyTitle = String(pd?.title ?? rd?.title ?? "").trim() || propertyId;
      }
      const { data: senderFull } = await db
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle();
      const chat = await deliverResidentPropertyManagerChatMessage(db, {
        residentEmail: senderEmail,
        residentUserId: user.id,
        residentName: fromName || String(senderFull?.full_name ?? "").trim() || "Resident",
        managerUserId: managerUserIdForProperty,
        managerEmail: recipients[0]!.email,
        propertyId,
        propertyTitle,
        subject,
        message: text,
      });
      propertyThreadId = chat.threadId;
      // This branch resolved the property's owning manager explicitly, so it is
      // a firmer identity than the single-recipient case above — and it is the
      // path a resident uses to message the manager of a specific property,
      // which is exactly where a repair gets reported.
      queueResidentWorkflow(
        managerUserIdForProperty,
        fromName || String(senderFull?.full_name ?? "").trim() || "Resident",
      );
    }

    if (deliverToPortalInbox && recipients.length > 0 && !residentPropertyChat) {
      const senderScope = scopeForRole(senderRole);

      const when = formatPacificDateTime(new Date());
      const preview = text.slice(0, 100).replace(/\n/g, " ");
      const portalSenderRole = mapProfileRoleToAdminInboxSenderRole(senderRole);
      for (const recipient of recipients) {
        if (isPrimaryAdminRecipientEmail(recipient.email)) {
          await deliverPortalMessageToAdminSharedInbox(db, {
            senderEmail,
            senderName: fromName,
            senderRole: portalSenderRole,
            subject,
            body: text,
          });
        }
      }
      for (const recipient of recipients) {
        const ts = Date.now();
        const rand = Math.random().toString(36).slice(2, 6);
        const recipientLower = recipient.email;

        if (isPrimaryAdminRecipientEmail(recipientLower)) {
          // Manager/resident sent copy — one thread with PropLane admin.
          await deliverPortalMessageThreadSide(db, {
            scope: senderScope,
            folder: "sent",
            ownerUserId: user.id,
            participantEmail: null,
            otherPartyEmail: PRIMARY_ADMIN_EMAIL.trim().toLowerCase(),
            fallbackId: `msg_${user.id}_${ts}_${rand}`,
            fromName,
            subject,
            body: text,
            preview,
            when,
            unread: false,
            outbound: true,
            attachments: inboxAttachmentsFromUrls(attachmentUrls),
          });
          continue;
        }

        // Sender's Sent record (owner-only, scoped to the sender's portal).
        // Repeated sends to the same person append to the ONE sent thread.
        await deliverPortalMessageThreadSide(db, {
          scope: senderScope,
          folder: "sent",
          ownerUserId: user.id,
          participantEmail: null,
          otherPartyEmail: recipientLower,
          fallbackId: `msg_${user.id}_${ts}_${rand}`,
          fromName,
          subject,
          body: text,
          preview,
          when,
          unread: false,
          outbound: true,
          attachments: inboxAttachmentsFromUrls(attachmentUrls),
        });

        if (recipientLower === senderEmail) continue;

        // Recipient's inbox record in their own scope — likewise one thread per
        // sender, with each new message appended as an inbound turn.
        await deliverPortalMessageThreadSide(db, {
          scope: recipient.scope,
          folder: "inbox",
          ownerUserId: recipient.userId,
          participantEmail: recipientLower,
          otherPartyEmail: senderEmail,
          fallbackId: `msg_inbox_${ts}_${rand}`,
          fromName,
          subject,
          body: text,
          preview,
          when,
          unread: true,
          outbound: false,
          attachments: inboxAttachmentsFromUrls(attachmentUrls),
        });
      }

      // The fresh-compose case: no thread to reply into and no property, so
      // neither hook above fired, but the message has now landed in the
      // recipient's inbox. `workflowQueued` keeps this a no-op when one of them
      // already claimed it.
      if (
        senderRole === "resident" &&
        recipients.length === 1 &&
        recipients[0]!.userId &&
        !isPrimaryAdminRecipientEmail(recipients[0]!.email)
      ) {
        queueResidentWorkflow(recipients[0]!.userId!);
      }

      // Push notification, best-effort. Keep the payload generic (sender name
      // only) since messages here can carry sensitive lease/payment details.
      try {
        const pushCandidates = recipients.filter((r) => r.email !== senderEmail);
        const missingIdEmails = pushCandidates.filter((r) => !r.userId).map((r) => r.email);
        const resolvedIds = new Map<string, string>();
        if (missingIdEmails.length > 0) {
          const { data: resolvedProfiles } = await db
            .from("profiles")
            .select("id, email")
            .in("email", missingIdEmails);
          for (const p of resolvedProfiles ?? []) {
            const email = String(p.email ?? "").trim().toLowerCase();
            if (email) resolvedIds.set(email, p.id as string);
          }
        }
        await Promise.all(
          pushCandidates.map((r) => {
            const uid = r.userId ?? resolvedIds.get(r.email);
            if (!uid) return Promise.resolve();
            if (eventCategory && channelByEmail.get(r.email)?.inbox !== true) {
              return Promise.resolve();
            }
            return sendPushToUser(uid, {
              title: `New message from ${fromName}`,
              body: "You have a new message in your PropLane inbox.",
              url: inboxDeepLinkForRole(r.role),
            }).catch(() => {});
          }),
        );
      } catch {
        /* non-critical — no-ops when FCM is not configured */
      }
    }

    // If no eligible real email recipients and SMS not requested, short-circuit
    if (toEmails.length === 0 && !anySmsWanted) {
      const sentAt = new Date().toISOString();
      for (const recipient of recipients) {
        const logId = `outbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.from("portal_outbound_mail_records").upsert(
          {
            id: logId,
            recipient_email: recipient.email,
            subject,
            channel: "email",
            row_data: { id: logId, to: recipient.email, subject, body: text, sentAt, emailSent: false },
          },
          { onConflict: "id" },
        );
      }
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "No eligible real recipients — portal inbox updated.",
        ...(propertyThreadId ? { propertyThreadId } : {}),
      });
    }

    let emailResendId: string | null = null;
    let emailSent = false;
    let emailResults = new Map<string, { sent: boolean; resendId: string | null }>();

    if (emailToSend.length > 0) {
      const html = `<p style="white-space:pre-wrap;font-family:sans-serif;font-size:15px;line-height:1.6;color:#1e293b">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p><hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0"><p style="font-family:sans-serif;font-size:12px;color:#94a3b8">Sent via PropLane portal by ${fromName}</p>`;
      // Per-recipient sends carrying the signed Reply-To + threading anchor.
      // Inbox already written — email stays best-effort, soft-failing per recipient.
      emailResults = await sendPortalConversationEmails({
        senderUserId: user.id,
        toEmails: emailToSend,
        subject,
        text,
        html,
      });
      for (const email of emailToSend) {
        const result = emailResults.get(email);
        if (result?.sent) {
          emailSent = true;
          emailResendId = emailResendId ?? result.resendId;
        }
      }
    }

    const sentAt = new Date().toISOString();

    // Log email sends
    if (emailToSend.length > 0) {
      for (const recipient of recipients) {
        const logId = `outbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.from("portal_outbound_mail_records").upsert(
          {
            id: logId,
            recipient_email: recipient.email,
            subject,
            channel: emailSent ? "email" : "portal",
            row_data: {
              id: logId,
              to: recipient.email,
              subject,
              body: text,
              sentAt,
              emailSent: emailResults.get(recipient.email)?.sent === true,
              emailResendId: emailResults.get(recipient.email)?.resendId ?? null,
            },
          },
          { onConflict: "id" },
        );
      }
    }

    // SMS delivery. In category mode each recipient is gated by their resolved
    // SMS channel (verified, non-opted-out phone + pref on); legacy mode texts
    // every recipient with a phone (STOP opt-out still enforced inside sendSms).
    if (anySmsWanted) {
      const senderRoleNorm = String(senderRole ?? "").trim().toLowerCase();
      if (senderRoleNorm === "resident" || senderRoleNorm === "vendor") {
        const { data: senderFull } = await db
          .from("profiles")
          .select("phone, phone_verified_at, full_name")
          .eq("id", user.id)
          .maybeSingle();
        const residentPhone =
          senderFull?.phone_verified_at && senderFull.phone
            ? normalizeE164(String(senderFull.phone))
            : null;
        await Promise.all(
          recipients.map(async (recipient) => {
            if (eventCategory && channelByEmail.get(recipient.email)?.sms !== true) return;
            const role = String(recipient.role ?? "").trim().toLowerCase();
            if (role !== "manager" && role !== "pro" && role !== "admin" && role !== "owner") return;
            const { data: mgr } = await db
              .from("profiles")
              .select("id, phone, phone_verified_at")
              .eq("email", recipient.email)
              .maybeSingle();
            const mgrId = String(mgr?.id ?? recipient.userId ?? "").trim();
            if (!mgrId) return;
            if (senderRoleNorm === "resident" && residentPhone) {
              let thread = await findThreadByResidentPhone(residentPhone, mgrId);
              if (!thread) {
                thread = await openClawResidentThread({
                  managerUserId: mgrId,
                  residentPhone,
                  residentUserId: user.id,
                  residentEmail: senderEmail,
                  topic: "general",
                  bumpLastMessage: true,
                });
              }
              if (!thread) return;
              await forwardResidentMessageToManagers({
                fromResident: residentPhone,
                text: rawText || "(attachment)",
                thread,
                briefText: `(${subject})\n${text}`,
              });
              return;
            }
            const mgrPhone =
              mgr?.phone_verified_at && mgr?.phone ? normalizeE164(String(mgr.phone)) : null;
            if (!mgrPhone) return;
            const vendorName = String(senderFull?.full_name ?? "Vendor").trim();
            const prefix = senderRoleNorm === "vendor" ? `Vendor ${vendorName}` : "Resident";
            await sendPropLaneSms({
              to: mgrPhone,
              text: `(${prefix}) ${subject}\n${text}`.slice(0, 1500),
            });
          }),
        );
      } else {
      const { data: senderProfile } = await db.from("profiles").select("sms_from_number").eq("id", user.id).maybeSingle();
      const smsFromNumber = String(senderProfile?.sms_from_number ?? "").trim();

      if (canSendResidentOutboundSms(smsFromNumber)) {
        // Fetch phone numbers for all recipients
        const recipientEmails = recipients.map((r) => r.email);
        const { data: phones } = await db
          .from("profiles")
          .select("email, phone")
          .in("email", recipientEmails);
        const phoneByEmail = new Map((phones ?? []).map((p) => [String(p.email).toLowerCase(), String(p.phone ?? "").trim()]));

        const senderIsManager = ["manager", "pro", "admin"].includes(String(senderRole ?? "").toLowerCase());
        // Parallel fan-out — a broadcast to N residents must not pay N serial
        // Claw relay round-trips inside the request.
        await Promise.all(
          recipients.map(async (recipient) => {
          if (eventCategory && channelByEmail.get(recipient.email)?.sms !== true) return;
          const recipientPhone = phoneByEmail.get(recipient.email) ?? "";
          if (!recipientPhone) return;
          let smsText = `(${subject})\n${text}`;
          const linkKind: ResidentSmsLinkKind | null =
            eventCategory === "leases"
              ? "lease"
              : eventCategory === "payments"
                ? "payments"
                : eventCategory === "maintenance"
                  ? "services_work_orders"
                  : eventCategory === "applications"
                    ? "applications"
                    : eventCategory
                      ? "inbox"
                      : null;
          if (linkKind) smsText = ensureSmsIncludesPortalLink(smsText, linkKind);
          const recipientIsResident =
            String(recipient.role ?? "").toLowerCase() === "resident" ||
            recipient.scope.includes("resident");
          // A manager's own compose (no event category) still opens the relay
          // thread — future resident replies route back to their phone — but is
          // NOT mirrored back to them: they just wrote it.
          const openThread =
            eventCategory === "payments" ||
            eventCategory === "leases" ||
            eventCategory === "maintenance" ||
            eventCategory === "applications"
              ? {
                  managerUserId: user.id,
                  residentUserId: recipient.userId,
                  residentEmail: recipient.email,
                  topic:
                    eventCategory === "leases"
                      ? ("lease" as const)
                      : eventCategory === "payments"
                        ? ("payment" as const)
                        : eventCategory === "applications"
                          ? ("applications" as const)
                          : ("maintenance" as const),
                }
              : senderIsManager && recipientIsResident
                ? {
                    managerUserId: user.id,
                    residentUserId: recipient.userId,
                    residentEmail: recipient.email,
                    topic: "general" as const,
                  }
                : null;
          const result = await sendResidentOutboundSms({
            to: recipientPhone,
            text: smsText,
            fromNumber: smsFromNumber,
            linkKind: null,
            sendClass: eventCategory ? "automated" : "transactional",
            openThread,
            mirrorToManager: Boolean(eventCategory),
          });
          if (result.sent) {
            const logId = `outbound_sms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            await db.from("portal_outbound_mail_records").upsert(
              {
                id: logId,
                recipient_email: recipient.email,
                subject,
                channel: "sms",
                row_data: {
                  id: logId,
                  to: recipientPhone,
                  subject,
                  body: text,
                  sentAt,
                  smsSent: true,
                  smsChannel: result.channel ?? null,
                },
              },
              { onConflict: "id" },
            );
          }
          }),
        );
      }
      }
    }

    track("message_sent", user.id, { delivered: Boolean(emailResendId) });
    return NextResponse.json({
      ok: true,
      id: emailResendId,
      ...(propertyThreadId ? { propertyThreadId } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
