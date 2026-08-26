import { formatPacificDateTime } from "@/lib/pacific-time";
import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { collectLinkedPropertyIdsForUser } from "@/lib/auth/manager-lease-scope";
import { track } from "@/lib/analytics/posthog";
import { chargeDueLabel, isUnpaidHouseholdCharge, type HouseholdCharge } from "@/lib/household-charges";
import { buildManualPaymentInstructionLines, buildPaymentReminderBody } from "@/lib/manual-payment-instructions";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { canSendResidentOutboundSms, sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";

export const runtime = "nodejs";

function canSendPaymentReminder(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isUsableEmail(email: string): boolean {
  return Boolean(email && email.includes("@"));
}

async function loadChargeForReminder(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  chargeId: string,
  admin: boolean,
): Promise<{ charge: HouseholdCharge; managerUserId: string } | null> {
  const { data, error } = await db
    .from("portal_household_charge_records")
    .select("row_data, manager_user_id")
    .eq("id", chargeId)
    .maybeSingle();
  if (error || !data?.row_data) return null;

  const charge = data.row_data as HouseholdCharge;
  const managerUserId = data.manager_user_id?.trim() || charge.managerUserId?.trim() || "";
  if (admin || (managerUserId && managerUserId === userId)) {
    return { charge, managerUserId };
  }

  const propertyId = charge.propertyId?.trim() ?? "";
  if (propertyId) {
    const linked = await collectLinkedPropertyIdsForUser(db, userId);
    if (linked.has(propertyId)) return { charge, managerUserId };
  }

  return null;
}

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      chargeId?: string;
      viaEmail?: boolean;
      viaSms?: boolean;
      subject?: string;
      text?: string;
    };

    const db = createSupabaseServiceRoleClient();
    const [{ data: requestor }, admin] = await Promise.all([
      db.from("profiles").select("role, full_name, email, sms_from_number").eq("id", user.id).maybeSingle(),
      isAdminUser(user.id),
    ]);
    if (!admin && !canSendPaymentReminder(requestor?.role)) {
      return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 403 });
    }

    const chargeId = String(body.chargeId ?? "").trim();
    if (!chargeId) {
      return NextResponse.json({ ok: false, error: "chargeId is required." }, { status: 400 });
    }

    const loaded = await loadChargeForReminder(db, user.id, chargeId, admin);
    if (!loaded) {
      return NextResponse.json({ ok: false, error: "Charge not found." }, { status: 404 });
    }
    const ownedCharge = loaded.charge;
    if (!isUnpaidHouseholdCharge(ownedCharge)) {
      return NextResponse.json(
        { ok: false, error: "This charge is already paid. Reminders are not sent for paid charges.", code: "charge_paid" },
        { status: 409 },
      );
    }

    const residentEmail = String(ownedCharge.residentEmail ?? "").trim().toLowerCase();
    const residentName = String(ownedCharge.residentName ?? "Resident").trim();
    const chargeTitle = String(ownedCharge.title ?? "outstanding charge").trim();
    const balanceDue = String(ownedCharge.balanceLabel ?? "").trim();
    const dueDate = String(chargeDueLabel(ownedCharge)).trim();
    const propertyLabel = String(ownedCharge.propertyLabel ?? "").trim();
    const managerProfile = requestor;
    const managerName =
      managerProfile?.full_name?.trim() || managerProfile?.email?.trim() || "Your property manager";
    const smsFromNumber = String(managerProfile?.sms_from_number ?? "").trim();

    const chargeResidentUserId = String(ownedCharge.residentUserId ?? "").trim() || null;
    let residentProfile: {
      id: string;
      email: string | null;
      phone: string | null;
    } | null = null;
    if (chargeResidentUserId) {
      const { data } = await db
        .from("profiles")
        .select("id, email, phone")
        .eq("id", chargeResidentUserId)
        .maybeSingle();
      if (data) {
        residentProfile = {
          id: String(data.id),
          email: (data.email as string | null) ?? null,
          phone: (data.phone as string | null) ?? null,
        };
      }
    }
    if (!residentProfile && isUsableEmail(residentEmail)) {
      const { data } = await db
        .from("profiles")
        .select("id, email, phone")
        .eq("email", residentEmail)
        .maybeSingle();
      if (data) {
        residentProfile = {
          id: String(data.id),
          email: (data.email as string | null) ?? null,
          phone: (data.phone as string | null) ?? null,
        };
      }
    }

    const inboxEmail =
      (isUsableEmail(residentEmail) ? residentEmail : "") ||
      String(residentProfile?.email ?? "").trim().toLowerCase() ||
      "";
    const residentPhone = String(residentProfile?.phone ?? "").trim();
    const residentUserId = residentProfile?.id?.trim() || chargeResidentUserId;

    const wantEmail = body.viaEmail !== false;
    const wantSms = body.viaSms === true;
    const canEmailExternally =
      wantEmail &&
      isUsableEmail(inboxEmail) &&
      !shouldSkipOutboundEmail(inboxEmail) &&
      inboxEmail !== (user.email ?? "").trim().toLowerCase();
    const canSms = wantSms && Boolean(residentPhone) && canSendResidentOutboundSms(smsFromNumber);

    if (!inboxEmail && !canSms) {
      return NextResponse.json(
        {
          ok: false,
          error: "Add a resident email or phone number (and set up your work number) to send a reminder.",
        },
        { status: 400 },
      );
    }

    const subject =
      String(body.subject ?? "").trim() || `Payment reminder: ${chargeTitle}`;
    const messageBody =
      String(body.text ?? "").trim() ||
      buildPaymentReminderBody({
        residentName,
        residentEmail: ownedCharge.residentEmail?.trim(),
        chargeTitle,
        balanceDue,
        dueDate,
        propertyLabel,
        managerName,
        manualPaymentLines: buildManualPaymentInstructionLines(ownedCharge),
      });

    // Always write Axis inbox when we have any email key (real or sandbox).
    if (inboxEmail) {
      await deliverToPortalInbox({
        db,
        userId: user.id,
        managerEmail: user.email ?? "",
        residentEmail: inboxEmail,
        subject,
        messageBody,
        managerName,
        residentUserId,
      });
    }

    let emailSent = false;
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (canEmailExternally && apiKey) {
      const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
      const html = `<p style="white-space:pre-wrap;font-family:sans-serif;font-size:15px;line-height:1.6;color:#1e293b">${escapeHtmlText(messageBody)}</p><hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0"><p style="font-family:sans-serif;font-size:12px;color:#94a3b8">Sent via PropLane portal by ${escapeHtmlText(managerName)}</p>`;
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [inboxEmail], subject, text: messageBody, html }),
          signal: AbortSignal.timeout(15_000),
        });
        emailSent = res.ok;
      } catch {
        emailSent = false;
      }
    }

    const outboundId = `outbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await db.from("portal_outbound_mail_records").upsert(
      {
        id: outboundId,
        recipient_email: inboxEmail || `sms:${residentPhone}`,
        subject,
        channel: emailSent ? "email" : canSms ? "sms" : "portal",
        row_data: {
          id: outboundId,
          to: inboxEmail || residentPhone,
          subject,
          body: messageBody,
          sentAt: new Date().toISOString(),
          emailSent,
          chargeId,
        },
      },
      { onConflict: "id" },
    );

    let smsSent = false;
    if (canSms) {
      // Honor the manager's edited message on the SMS leg too — only fall
      // back to the canned copy when no custom text was provided.
      const smsBody =
        String(body.text ?? "").trim() ||
        `Hi ${residentName}, this is a payment reminder: ${chargeTitle}${balanceDue ? ` — ${balanceDue}` : ""}${propertyLabel ? ` (${propertyLabel})` : ""}. Reply here with questions. — ${managerName}`;
      const smsResult = await sendResidentOutboundSms({
        to: residentPhone,
        text: smsBody,
        fromNumber: smsFromNumber,
        linkKind: "payments",
        sendClass: "transactional",
        openThread: {
          managerUserId: user.id,
          residentUserId: residentUserId ?? null,
          residentEmail: inboxEmail || null,
          topic: "payment",
        },
      });
      smsSent = Boolean(smsResult.sent);
      if (smsSent) {
        const smsLogId = `outbound_sms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.from("portal_outbound_mail_records").upsert(
          {
            id: smsLogId,
            recipient_email: inboxEmail || `sms:${residentPhone}`,
            subject,
            channel: "sms",
            row_data: {
              id: smsLogId,
              to: residentPhone,
              subject,
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

    const skippedExternal = !emailSent && !smsSent;
    track("payment_reminder_sent", user.id, {
      email_sent: emailSent,
      sms_sent: smsSent,
    });
    return NextResponse.json({
      ok: true,
      emailSent,
      smsSent,
      skipped: skippedExternal,
      reason: skippedExternal ? "Saved to PropLane inbox (external email/SMS not sent)." : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

async function deliverToPortalInbox({
  db,
  userId,
  managerEmail,
  residentEmail,
  subject,
  messageBody,
  managerName,
  residentUserId,
}: {
  db: ReturnType<typeof createSupabaseServiceRoleClient>;
  userId: string;
  managerEmail: string;
  residentEmail: string;
  subject: string;
  messageBody: string;
  managerName: string;
  residentUserId?: string | null;
}) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const residentLower = residentEmail.toLowerCase();
  const senderLower = (managerEmail || "manager@example.com").toLowerCase();
  const when = formatPacificDateTime(new Date());
  const preview = messageBody.slice(0, 100).replace(/\n/g, " ");

  await deliverPortalMessageThreadSide(db, {
    scope: "axis_portal_inbox_manager_v1",
    folder: "sent",
    ownerUserId: userId,
    participantEmail: null,
    otherPartyEmail: residentLower,
    fallbackId: `payment_sent_${userId}_${ts}_${rand}`,
    fromName: managerName,
    subject,
    body: messageBody,
    preview,
    when,
    unread: false,
    outbound: true,
  });

  if (residentLower !== senderLower) {
    await deliverPortalMessageThreadSide(db, {
      scope: "axis_portal_inbox_resident_v1",
      folder: "inbox",
      ownerUserId: residentUserId || null,
      participantEmail: residentLower,
      otherPartyEmail: senderLower,
      fallbackId: `payment_inbox_${ts}_${rand}`,
      fromName: managerName,
      subject,
      body: messageBody,
      preview,
      when,
      unread: true,
      outbound: false,
    });
  }
}
