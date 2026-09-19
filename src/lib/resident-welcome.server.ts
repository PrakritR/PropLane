/**
 * Shared resident-welcome core: the account-setup email an approved applicant
 * receives (Resend send + portal inbox records + optional SMS). Extracted from
 * `/api/portal/send-resident-welcome` so the route and the agent's
 * send_resident_welcome tool run the exact same pipeline (one implementation,
 * not two). The tool-facing resolver derives the recipient email and Axis ID
 * from the landlord's OWN application record — never from client/model input.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";
import {
  RESIDENT_WELCOME_EMAIL_SUBJECT,
  buildResidentWelcomeEmailBody,
  buildResidentWelcomeEmailHtml,
  buildResidentWelcomeMailtoHref,
  residentAccountCreationUrl,
} from "@/lib/resident-welcome-email";
import {
  EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT,
  buildExistingResidentWelcomeEmailBody,
  buildExistingResidentWelcomeEmailHtml,
  buildExistingResidentWelcomeMailtoHref,
} from "@/lib/existing-resident-welcome-email";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { ensureResidentSetupTokenForApplication } from "@/lib/auth/resident-setup-token";
import { resolveManagerReachabilityForResident } from "@/lib/manager-reachability-for-resident.server";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import { postResendEmail as postCapturedResendEmail } from "@/lib/resend-delivery.server";

// Domain is matched as dot-separated labels (no char class overlaps the "." delimiter)
// so there is exactly one way to parse a match — avoids polynomial backtracking on
// attacker-controlled input.
export const RESIDENT_WELCOME_EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Import / harness inboxes must never receive Resend. SMS to a sheet phone still may. */
export function isPlaceholderResidentEmail(email: string): boolean {
  const to = email.trim().toLowerCase();
  return (
    to.endsWith("@axis.local") ||
    to.endsWith("@test.proplane.local") ||
    to.endsWith("@import.proplane.local")
  );
}

function skipExternalWelcomeEmail(to: string, senderEmail: string): boolean {
  return isPlaceholderResidentEmail(to) || (Boolean(senderEmail) && to === senderEmail);
}

async function postResendEmail(input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  mailtoHref: string;
}): Promise<{ ok: true; id: string | null } | { ok: false; status: 502; error: string; mailtoHref: string }> {
  try {
    const res = await postCapturedResendEmail({
      apiKey: input.apiKey,
      payload: {
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
      },
      effectSummary: input.subject || `Resident welcome email to ${input.to} captured for SMS test mode.`,
      metadata: { recipient: input.to },
    });
    const payload = (await res.json().catch(() => ({}))) as { message?: string; id?: string; name?: string };
    if (!res.ok) {
      return {
        ok: false,
        status: 502,
        error: payload.message ?? res.statusText ?? "Resend request failed.",
        mailtoHref: input.mailtoHref,
      };
    }
    return { ok: true, id: payload.id ?? null };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Resend request failed.",
      mailtoHref: input.mailtoHref,
    };
  }
}

/** Roles allowed to send the welcome email (matches the original route gate). */
export function canSendResidentWelcome(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

/** True when the welcome email can actually be delivered externally (Resend configured). */
export function residentWelcomeEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

/**
 * The existing-resident portal-ready SMS body (extracted from the inline
 * literal below so any server-side sender can send the identical message).
 * `owner-sms-dispatcher.server.ts` / `sendSms` never append opt-out text
 * themselves, so it is included here.
 */
export function buildResidentWelcomeSmsBody(input: {
  residentName?: string;
  axisId: string;
  senderName: string;
  propertyLabel?: string;
  setupUrl?: string;
}): string {
  const residentName = input.residentName?.trim() ?? "";
  const setup = input.setupUrl?.trim() ? ` Set up your account: ${input.setupUrl.trim()}` : "";
  return `Your PropLane resident portal is ready${residentName ? `, ${residentName}` : ""}. Pay rent and manage your home online.${setup} PropLane ID: ${formatProplaneIdForDisplay(input.axisId)}. — ${input.senderName} Reply STOP to opt out.`;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export type ResidentWelcomeTarget = {
  applicationId: string;
  /** Recipient email resolved from the stored application row. May be "" when none is on file. */
  to: string;
  residentName: string;
  axisId: string;
};

/**
 * Resolve the welcome-email target from the landlord's OWN application record.
 * Returns null when the application does not exist or belongs to another
 * landlord — the caller must treat that as "not found", never fall back to
 * caller-supplied values.
 */
export async function resolveResidentWelcomeTarget(
  db: SupabaseClient,
  managerUserId: string,
  applicationId: string,
): Promise<ResidentWelcomeTarget | null> {
  const id = applicationId.trim();
  if (!id || !managerUserId.trim()) return null;
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, resident_email, row_data")
    .eq("id", id)
    .eq("manager_user_id", managerUserId)
    .limit(1);
  if (error) return null;
  const rec = ((data ?? []) as { id: string; resident_email?: string | null; row_data?: unknown }[])[0];
  if (!rec) return null;
  const row = (rec.row_data && typeof rec.row_data === "object" ? rec.row_data : {}) as {
    name?: string;
    email?: string;
  };
  return {
    applicationId: rec.id,
    to: normalizeEmail(row.email) || normalizeEmail(rec.resident_email),
    residentName: typeof row.name === "string" ? row.name.trim() : "",
    axisId: normalizeApplicationAxisId(String(rec.id)),
  };
}

export type ResidentWelcomeActor = {
  /** Authenticated sender's user id (owns the manager Sent inbox record). */
  userId: string;
  /** Sender's email — used for self-send/demo skip and inbox sender labels. */
  email: string | null;
};

export type DeliverResidentWelcomeResult =
  | { ok: true; id: string | null; skipped: boolean; smsSent?: boolean }
  | { ok: false; status: 502 | 503; error: string; mailtoHref: string };

/**
 * Send the welcome/account-setup email and record it in the manager's Sent
 * inbox (plus the resident's inbox and an optional SMS for real deliveries).
 * Demo addresses (@axis.local) and self-sends skip the external email but
 * still record the manager Sent thread. When Resend is not configured, returns
 * an honest error with a mailto fallback instead of sending.
 */
export async function deliverResidentWelcome(
  db: SupabaseClient,
  actor: ResidentWelcomeActor,
  input: { to: string; residentName?: string; axisId: string },
): Promise<DeliverResidentWelcomeResult> {
  const to = normalizeEmail(input.to);
  const residentName = input.residentName?.trim() ?? "";
  const axisId = input.axisId.trim();

  const senderEmail = normalizeEmail(actor.email);
  const skipExternalEmail = skipExternalWelcomeEmail(to, senderEmail);

  // Mint (or refresh) a setup token on the application so the approval email links
  // to a working /auth/resident-setup?token=&axis_id= handoff — the same machinery
  // the guest apply flow uses. Scoped to the sending manager so one manager cannot
  // rotate another's applicant token. A missing token (application not found under
  // this manager) falls back to the token-less URL, which the setup page rejects
  // gracefully with "apply first".
  const ensured = await ensureResidentSetupTokenForApplication(db, axisId, {
    managerUserId: actor.userId,
  });
  const setupToken = ensured.ok ? ensured.token : undefined;

  const managerReachability = await resolveManagerReachabilityForResident(db, actor.userId);

  const signupUrl = residentAccountCreationUrl("", axisId, setupToken);
  const text = buildResidentWelcomeEmailBody({
    residentName: residentName || undefined,
    axisId,
    signupUrl,
    managerReachability,
  });
  const html = buildResidentWelcomeEmailHtml({
    residentName: residentName || undefined,
    axisId,
    signupUrl,
    managerReachability,
  });
  const mailtoHref = buildResidentWelcomeMailtoHref({
    residentEmail: to,
    residentName: residentName || undefined,
    axisId,
    origin: "",
    setupToken,
    managerReachability,
  });

  let payloadId: string | null = null;
  if (!skipExternalEmail) {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return {
        ok: false,
        status: 503,
        error: "Email delivery is not configured (set RESEND_API_KEY).",
        mailtoHref,
      };
    }

    const from = await managerOutboundFromHeader(db, actor.userId);
    const sent = await postResendEmail({
      apiKey,
      from,
      to,
      subject: RESIDENT_WELCOME_EMAIL_SUBJECT,
      text,
      html,
      mailtoHref,
    });
    if (!sent.ok) return sent;
    payloadId = sent.id;
  }

  // Deliver to portal inboxes: manager's Sent + resident's Unopened
  try {
    const when = formatPacificDateTime(new Date());
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    const senderName = actor.email ?? "PropLane";
    const senderLower = senderEmail || "manager@example.com";
    const preview = text.slice(0, 100).replace(/\n/g, " ");

    // Manager's Sent record (no participant_email so the resident doesn't get this copy)
    const managerThreadId = `welcome_${actor.userId}_${ts}_${rand}`;
    await db.from("portal_inbox_thread_records").upsert(
      {
        id: managerThreadId,
        scope: "axis_portal_inbox_manager_v1",
        owner_user_id: actor.userId,
        participant_email: null,
        thread_type: "portal_message",
        row_data: {
          id: managerThreadId,
          folder: "sent",
          from: senderName,
          email: to,
          subject: RESIDENT_WELCOME_EMAIL_SUBJECT,
          preview,
          body: text,
          time: when,
          unread: false,
          scope: "axis_portal_inbox_manager_v1",
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

    // Resident's Unopened record (skip self-send and @axis.local to avoid polluting inboxes)
    if (!skipExternalEmail && to !== senderLower) {
      const residentThreadId = `welcome_inbox_${ts}_${rand}`;
      await db.from("portal_inbox_thread_records").upsert(
        {
          id: residentThreadId,
          scope: "axis_portal_inbox_resident_v1",
          owner_user_id: null,
          participant_email: to,
          thread_type: "portal_message",
          row_data: {
            id: residentThreadId,
            folder: "inbox",
            from: senderName,
            email: senderLower,
            subject: RESIDENT_WELCOME_EMAIL_SUBJECT,
            preview,
            body: text,
            time: when,
            unread: true,
            scope: "axis_portal_inbox_resident_v1",
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
    }
  } catch {
    /* non-critical — email already sent */
  }

  // SMS welcome if manager has sms_from_number configured
  try {
    const { data: managerProfile } = await db.from("profiles").select("sms_from_number, full_name").eq("id", actor.userId).maybeSingle();
    if (!skipExternalEmail) {
      const { data: residentProfile } = await db.from("profiles").select("phone").eq("email", to).maybeSingle();
      const residentPhone = String(residentProfile?.phone ?? "").trim();
      if (residentPhone) {
        const senderName = String(managerProfile?.full_name ?? actor.email ?? "Your property manager").trim() || "Your property manager";
        const smsBody = `Welcome${residentName ? `, ${residentName}` : ""}! Your PropLane resident portal is ready. Your PropLane ID: ${formatProplaneIdForDisplay(axisId)}. — ${senderName}`;
        await enqueueOwnerSms({ managerUserId: actor.userId, actorUserId: actor.userId, recipientPhone: residentPhone, recipientEmail: to, body: smsBody, sendClass: "transactional", purpose: "resident_welcome", counterpartyRole: "resident", dedupeKey: `welcome:${actor.userId}:${axisId}:${payloadId}` }, db);
      }
    }
  } catch { /* non-critical */ }

  return { ok: true, id: payloadId, skipped: skipExternalEmail };
}

/** Portal onboarding email for manager-added existing residents (not applicants). */
export async function deliverExistingResidentWelcome(
  db: SupabaseClient,
  actor: ResidentWelcomeActor,
  input: {
    to: string;
    residentName?: string;
    axisId: string;
    propertyLabel?: string;
    residentPhone?: string;
    channels?: { viaEmail?: boolean; viaSms?: boolean; viaInbox?: boolean };
  },
): Promise<DeliverResidentWelcomeResult> {
  const to = normalizeEmail(input.to);
  const residentName = input.residentName?.trim() ?? "";
  const axisId = input.axisId.trim();
  const propertyLabel = input.propertyLabel?.trim() ?? "";

  const senderEmail = normalizeEmail(actor.email);
  const skipExternalEmail = skipExternalWelcomeEmail(to, senderEmail);
  const viaEmail = input.channels?.viaEmail !== false;
  const viaSms = input.channels?.viaSms !== false;
  const viaInbox = input.channels?.viaInbox !== false;

  const ensured = await ensureResidentSetupTokenForApplication(db, axisId, {
    managerUserId: actor.userId,
  });
  const setupToken = ensured.ok ? ensured.token : undefined;

  const managerReachability = await resolveManagerReachabilityForResident(db, actor.userId);

  const signupUrl = residentAccountCreationUrl("", axisId, setupToken);
  const text = buildExistingResidentWelcomeEmailBody({
    residentName: residentName || undefined,
    axisId,
    signupUrl,
    propertyLabel: propertyLabel || undefined,
    managerReachability,
  });
  const html = buildExistingResidentWelcomeEmailHtml({
    residentName: residentName || undefined,
    axisId,
    signupUrl,
    propertyLabel: propertyLabel || undefined,
    managerReachability,
  });
  const mailtoHref = buildExistingResidentWelcomeMailtoHref({
    residentEmail: to,
    residentName: residentName || undefined,
    axisId,
    origin: "",
    setupToken,
    propertyLabel: propertyLabel || undefined,
    managerReachability,
  });

  let payloadId: string | null = null;
  if (viaEmail && !skipExternalEmail) {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return {
        ok: false,
        status: 503,
        error: "Email delivery is not configured (set RESEND_API_KEY).",
        mailtoHref,
      };
    }

    const from = await managerOutboundFromHeader(db, actor.userId);
    const sent = await postResendEmail({
      apiKey,
      from,
      to,
      subject: EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT,
      text,
      html,
      mailtoHref,
    });
    if (!sent.ok) return sent;
    payloadId = sent.id;
  }

  try {
    const when = formatPacificDateTime(new Date());
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    const senderName = actor.email ?? "PropLane";
    const senderLower = senderEmail || "manager@example.com";
    const preview = text.slice(0, 100).replace(/\n/g, " ");

    const managerThreadId = `welcome_existing_${actor.userId}_${ts}_${rand}`;
    await db.from("portal_inbox_thread_records").upsert(
      {
        id: managerThreadId,
        scope: "axis_portal_inbox_manager_v1",
        owner_user_id: actor.userId,
        participant_email: null,
        thread_type: "portal_message",
        row_data: {
          id: managerThreadId,
          folder: "sent",
          from: senderName,
          email: to,
          subject: EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT,
          preview,
          body: text,
          time: when,
          unread: false,
          scope: "axis_portal_inbox_manager_v1",
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

    if (viaInbox && !skipExternalEmail && to !== senderLower) {
      const residentThreadId = `welcome_existing_inbox_${ts}_${rand}`;
      await db.from("portal_inbox_thread_records").upsert(
        {
          id: residentThreadId,
          scope: "axis_portal_inbox_resident_v1",
          owner_user_id: null,
          participant_email: to,
          thread_type: "portal_message",
          row_data: {
            id: residentThreadId,
            folder: "inbox",
            from: senderName,
            email: senderLower,
            subject: EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT,
            preview,
            body: text,
            time: when,
            unread: true,
            scope: "axis_portal_inbox_resident_v1",
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
    }
  } catch {
    /* non-critical */
  }

  let smsSent = false;
  try {
    const { data: managerProfile } = await db.from("profiles").select("sms_from_number, full_name").eq("id", actor.userId).maybeSingle();
    if (viaSms) {
      const { data: residentProfile } = await db.from("profiles").select("phone").eq("email", to).maybeSingle();
      const residentPhone = input.residentPhone?.trim() || String(residentProfile?.phone ?? "").trim();
      if (residentPhone) {
        const senderName = String(managerProfile?.full_name ?? actor.email ?? "Your property manager").trim() || "Your property manager";
        const smsBody = buildResidentWelcomeSmsBody({
          residentName,
          axisId,
          senderName,
          setupUrl: isPlaceholderResidentEmail(to) ? signupUrl : undefined,
        });
        await enqueueOwnerSms({ managerUserId: actor.userId, actorUserId: actor.userId, recipientPhone: residentPhone, recipientEmail: to, body: smsBody, sendClass: "transactional", purpose: "resident_welcome", counterpartyRole: "resident", dedupeKey: `welcome:${actor.userId}:${axisId}:${payloadId}` }, db);
        smsSent = true;
      }
    }
  } catch { /* non-critical */ }

  return { ok: true, id: payloadId, skipped: skipExternalEmail, smsSent };
}
