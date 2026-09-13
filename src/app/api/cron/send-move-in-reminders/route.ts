import { NextResponse } from "next/server";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { isProductionRuntime } from "@/lib/server-env";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadResidentMoveInForEmail } from "@/lib/resident-move-in-info";
import {
  MOVE_IN_REMINDER_SUBJECT,
  buildMoveInReminderText,
  buildMoveInReminderHtml,
} from "@/lib/move-in-reminder-email";
import { canSendResidentOutboundSms, sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import { sendPushToUser } from "@/lib/push-notifications.server";

export const runtime = "nodejs";

// Vercel Cron sends "Authorization: Bearer $CRON_SECRET" on every invocation.
function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  // Not configured: allow in dev/preview, but fail closed in production.
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/** Parse a move-in date string into YYYY-MM-DD, handling "M/D/YYYY" and ISO formats. */
function normalizeMoveInDate(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null;
  const s = raw.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // "M/D/YYYY" or "MM/DD/YYYY"
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  return null;
}

/** Returns "YYYY-MM-DD" for tomorrow in UTC. */
function tomorrowUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function formatDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!);
  return dt.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tomorrow = tomorrowUtc();
  const db = createSupabaseServiceRoleClient();

  // Fetch all application records and find approved residents moving in tomorrow.
  const { data: records, error } = await db
    .from("manager_application_records")
    .select("resident_email, manager_user_id, row_data");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Dedupe by email — keep only approved records; prefer manualResidentDetails.moveInDate.
  const emailMap = new Map<string, { moveInDate: string; name: string; managerUserId: string | null }>();

  for (const rec of records ?? []) {
    const email = rec.resident_email?.trim().toLowerCase();
    if (!email || shouldSkipOutboundEmail(email)) continue;

    const row = rec.row_data as Record<string, unknown> | null;
    if (!row || typeof row !== "object") continue;

    const bucket = typeof row.bucket === "string" ? row.bucket.trim() : "";
    if (bucket !== "approved") continue;

    const manualDetails = row.manualResidentDetails as Record<string, unknown> | null | undefined;
    const application = row.application as Record<string, unknown> | null | undefined;

    const moveInDate = normalizeMoveInDate(
      (manualDetails?.moveInDate as string | undefined) ||
        (application?.leaseStart as string | undefined),
    );
    if (moveInDate !== tomorrow) continue;

    // Only add once per email (first approved record wins).
    if (!emailMap.has(email)) {
      const name =
        typeof row.name === "string"
          ? row.name.trim()
          : typeof (application?.fullLegalName) === "string"
            ? (application.fullLegalName as string).trim()
            : "";
      const managerUserId = typeof rec.manager_user_id === "string" ? rec.manager_user_id : null;
      emailMap.set(email, { moveInDate, name, managerUserId });
    }
  }

  if (emailMap.size === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped: 0, message: "No move-ins tomorrow." });
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  const moveInDateLabel = formatDateLabel(tomorrow);

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const [email, { name, managerUserId }] of emailMap) {
    // Dedup: skip if we already sent a reminder for this email + date.
    const dedupId = `move_in_reminder_${email}_${tomorrow}`;
    const { data: existing } = await db
      .from("portal_outbound_mail_records")
      .select("id")
      .eq("id", dedupId)
      .maybeSingle();

    if (existing) {
      skipped++;
      continue;
    }

    // Resolve full move-in details (property, address, instructions, house info).
    const moveIn = await loadResidentMoveInForEmail(email);

    const propertyLabel = moveIn?.propertyLabel ?? "your property";
    const addressLine = moveIn?.addressLine ?? "";
    const instructions = moveIn?.instructions ?? null;
    const generalHouseInfo = moveIn?.generalHouseInfo ?? null;
    const houseInfo = moveIn?.houseInfo ?? null;

    const text = buildMoveInReminderText({ residentName: name || undefined, propertyLabel, addressLine, moveInDateLabel, instructions, generalHouseInfo, houseInfo });
    const html = buildMoveInReminderHtml({ residentName: name || undefined, propertyLabel, addressLine, moveInDateLabel, instructions, generalHouseInfo, houseInfo });

    let emailSent = false;
    if (apiKey) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [email], subject: MOVE_IN_REMINDER_SUBJECT, text, html }),
        });
        emailSent = res.ok;
        if (!res.ok) {
          const payload = await res.json().catch(() => ({})) as { message?: string };
          errors.push(`${email}: ${payload.message ?? res.statusText}`);
        }
      } catch (e) {
        errors.push(`${email}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Deliver to resident's portal inbox.
    try {
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 6);
      const inboxId = `move_in_reminder_inbox_${ts}_${rand}`;
      const when = formatPacificDateTime(new Date());
      const preview = text.slice(0, 100).replace(/\n/g, " ");
      await db.from("portal_inbox_thread_records").upsert(
        {
          id: inboxId,
          scope: "axis_portal_inbox_resident_v1",
          owner_user_id: null,
          participant_email: email,
          thread_type: "portal_message",
          row_data: {
            id: inboxId,
            folder: "inbox",
            from: "PropLane",
            email: from.match(/<([^>]+)>/)?.[1] ?? from,
            subject: MOVE_IN_REMINDER_SUBJECT,
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
    } catch {
      /* non-critical */
    }

    // Record in outbound mail log (serves as dedup key on reruns).
    await db.from("portal_outbound_mail_records").upsert(
      {
        id: dedupId,
        recipient_email: email,
        subject: MOVE_IN_REMINDER_SUBJECT,
        channel: "email",
        row_data: { id: dedupId, to: email, subject: MOVE_IN_REMINDER_SUBJECT, body: text, sentAt: new Date().toISOString(), emailSent },
      },
      { onConflict: "id" },
    );

    // SMS delivery via Claw (preferred) or manager Twilio work number
    if (managerUserId) {
      try {
        const { data: managerProfile } = await db.from("profiles").select("sms_from_number, full_name").eq("id", managerUserId).maybeSingle();
        const smsFromNumber = String(managerProfile?.sms_from_number ?? "").trim();
        if (canSendResidentOutboundSms(smsFromNumber)) {
          const { data: residentProfile } = await db.from("profiles").select("phone").eq("email", email).maybeSingle();
          const residentPhone = String(residentProfile?.phone ?? "").trim();
          if (residentPhone) {
            const managerName = String(managerProfile?.full_name ?? "Your property manager").trim() || "Your property manager";
            const smsBody = `Hi ${name || "Resident"}, reminder: your move-in is tomorrow at ${propertyLabel}${addressLine ? `, ${addressLine}` : ""}. Reply here with questions. — ${managerName}`;
            const smsResult = await sendResidentOutboundSms({
              to: residentPhone,
              text: smsBody,
              fromNumber: smsFromNumber,
              linkKind: "move_in",
              openThread: {
                managerUserId,
                residentEmail: email,
                topic: "move_in",
              },
            });
            if (smsResult.sent) {
              const smsLogId = `outbound_sms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              await db.from("portal_outbound_mail_records").upsert(
                {
                  id: smsLogId,
                  recipient_email: email,
                  subject: MOVE_IN_REMINDER_SUBJECT,
                  channel: "sms",
                  row_data: {
                    id: smsLogId,
                    to: residentPhone,
                    subject: MOVE_IN_REMINDER_SUBJECT,
                    body: smsBody,
                    sentAt: new Date().toISOString(),
                    smsSent: true,
                    smsChannel: smsResult.channel ?? null,
                  },
                },
                { onConflict: "id" },
              );
            }
          }
        }
      } catch { /* non-critical */ }
    }

    // Push to the resident's registered app device(s); no-ops until FCM is set up.
    try {
      const { data: residentForPush } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
      const residentUserId = String(residentForPush?.id ?? "").trim();
      if (residentUserId) {
        await sendPushToUser(residentUserId, {
          title: "Move-in is tomorrow",
          body: `Your move-in at ${propertyLabel} is tomorrow.${addressLine ? ` ${addressLine}.` : ""}`,
          url: "/resident/dashboard",
        });
      }
    } catch {
      /* non-critical */
    }

    sent++;
  }

  return NextResponse.json({ ok: true, sent, skipped, errors: errors.length ? errors : undefined });
}
