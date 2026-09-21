import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { loadPaymentReminderChargeForActor, resolvePaymentReminderCapability } from "@/lib/payment-reminder-capability.server";
import { track } from "@/lib/analytics/posthog";
import { chargeDueLabel, isUnpaidHouseholdCharge } from "@/lib/household-charges";
import { buildPaymentReminderBody } from "@/lib/manual-payment-instructions";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { deliverManualPaymentReminder } from "@/lib/manual-payment-reminder-delivery.server";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";

export const runtime = "nodejs";

function isUsableEmail(email: string): boolean {
  return Boolean(email && email.includes("@"));
}

/** The composer checks a charge's actual workspace before offering SMS. */
export async function GET(req: Request) {
  try {
    const actor = await requireManagerRouteUser();
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
    const chargeId = new URL(req.url).searchParams.get("chargeId")?.trim() ?? "";
    if (!chargeId) return NextResponse.json({ error: "chargeId is required." }, { status: 400 });
    const admin = await isAdminUser(actor.userId);
    const context = await loadPaymentReminderChargeForActor(actor.db, actor.userId, chargeId, admin);
    if (!context) return NextResponse.json({ error: "Charge not found." }, { status: 404 });
    const capability = await resolvePaymentReminderCapability(actor.db, context);
    return NextResponse.json(capability, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not check messaging access." }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const actor = await requireManagerRouteUser();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 403 });

    const body = (await req.json().catch(() => ({}))) as {
      chargeId?: string;
      viaEmail?: boolean;
      viaSms?: boolean;
      subject?: string;
      text?: string;
      requestId?: string;
      chargeIds?: string[];
    };
    const requestId = String(body.requestId ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return NextResponse.json({ ok: false, code: "invalid_request_id", error: "A valid reminder request ID is required." }, { status: 400 });
    }

    const db = actor.db;
    const [{ data: requestor }, admin] = await Promise.all([
      db.from("profiles").select("full_name, email").eq("id", actor.userId).maybeSingle(),
      isAdminUser(actor.userId),
    ]);

    const chargeId = String(body.chargeId ?? "").trim();
    if (!chargeId) {
      return NextResponse.json({ ok: false, error: "chargeId is required." }, { status: 400 });
    }

    const loaded = await loadPaymentReminderChargeForActor(db, actor.userId, chargeId, admin);
    if (!loaded) {
      return NextResponse.json({ ok: false, error: "Charge not found." }, { status: 404 });
    }
    const ownedCharge = loaded.charge;
    const coveredChargeIds = [...new Set([chargeId, ...(Array.isArray(body.chargeIds) ? body.chargeIds : [])]
      .map((id) => String(id ?? "").trim()).filter(Boolean))].sort();
    if (coveredChargeIds.length > 25) {
      return NextResponse.json({ ok: false, error: "Too many charges in one reminder." }, { status: 400 });
    }
    for (const coveredId of coveredChargeIds) {
      if (coveredId === chargeId) continue;
      const covered = await loadPaymentReminderChargeForActor(db, actor.userId, coveredId, admin);
      if (!covered || covered.ownerUserId !== loaded.ownerUserId ||
          String(covered.charge.residentEmail ?? "").trim().toLowerCase() !== String(ownedCharge.residentEmail ?? "").trim().toLowerCase() ||
          !isUnpaidHouseholdCharge(covered.charge)) {
        return NextResponse.json({ ok: false, error: "The reminder group changed. Refresh payments and try again." }, { status: 409 });
      }
    }
    const { data: ownerProfile } = await db.from("profiles")
      .select("email")
      .eq("id", loaded.ownerUserId)
      .maybeSingle();
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
    const capability = await resolvePaymentReminderCapability(db, loaded);
    const smsFromNumber = capability.sms.fromNumber;

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
      if (data && String(data.email ?? "").trim().toLowerCase() === residentEmail) {
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
    // A stale charge user ID is never authority to deliver into that account.
    const residentUserId = residentProfile?.id?.trim() || null;

    const wantEmail = body.viaEmail !== false;
    const wantSms = body.viaSms === true;
    if (!wantEmail && !wantSms) {
      return NextResponse.json({ ok: false, error: "Choose email or SMS to send a reminder." }, { status: 400 });
    }
    if (wantEmail && !capability.email.available) {
      return NextResponse.json({ ok: false, error: capability.email.reason ?? "Email is unavailable." }, { status: 409 });
    }
    const canEmailExternally =
      wantEmail &&
      isUsableEmail(inboxEmail) &&
      !shouldSkipOutboundEmail(inboxEmail) &&
      inboxEmail !== String(requestor?.email ?? "").trim().toLowerCase();
    if (wantSms && !capability.sms.available) {
      return NextResponse.json(
        { ok: false, error: capability.sms.reason ?? "Text delivery is unavailable." },
        { status: 409 },
      );
    }
    const canSms = wantSms && Boolean(residentPhone) && Boolean(smsFromNumber);

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
      });

    // Honor an edited draft on both channels. The occurrence snapshot binds
    // this body and the covered charges to requestId before any provider call.
    const smsBody =
      String(body.text ?? "").trim() ||
      `Hi ${residentName}, this is a payment reminder: ${chargeTitle}${balanceDue ? ` — ${balanceDue}` : ""}${propertyLabel ? ` (${propertyLabel})` : ""}. Reply here with questions. — ${managerName}`;
    const delivery = await deliverManualPaymentReminder({
      db,
      ownerUserId: loaded.ownerUserId,
      actorUserId: actor.userId,
      requestId,
      chargeIds: coveredChargeIds,
      propertyId: loaded.propertyId,
      recipientEmail: inboxEmail || `sms:${residentPhone}`,
      inboxEmail,
      recipientPhone: residentPhone,
      residentUserId,
      managerEmail: String(ownerProfile?.email ?? ""),
      managerName,
      subject,
      text: messageBody,
      smsText: smsBody,
      wantEmail,
      wantSms: canSms,
      canEmailExternally,
      smsFromNumber,
      from: await managerOutboundFromHeader(db, loaded.ownerUserId),
    });
    if (delivery.conflict) {
      return NextResponse.json({ ok: false, code: "revision_conflict", error: "This reminder changed after sending started. Open a new draft to send again." }, { status: 409 });
    }
    const emailSent = delivery.email.status === "submitted";
    const smsSent = delivery.sms.sent;
    const smsQueued = delivery.sms.queued;
    const inboxSent = delivery.inbox.status === "submitted";
    const externalUnknown = delivery.email.status === "unknown" || delivery.sms.status === "unknown";
    const skippedExternal = !emailSent && !smsQueued;
    const accepted = emailSent || smsQueued || inboxSent;
    const inFlight = [delivery.email.status, delivery.sms.status, delivery.inbox.status].includes("claimed");
    const status = externalUnknown ? "unknown" : inFlight || (smsQueued && !smsSent) ? "pending" : !accepted ? "failed" :
      delivery.email.status === "failed" || delivery.sms.status === "failed" ? "partial" : "submitted";
    track("payment_reminder_sent", actor.userId, {
      email_sent: emailSent,
      sms_sent: smsSent,
      sms_queued: smsQueued,
    });
    return NextResponse.json({
      ok: accepted && !externalUnknown && !inFlight,
      status,
      occurrenceId: delivery.occurrenceId,
      coveredChargeIds,
      channels: { email: delivery.email, sms: delivery.sms, inbox: delivery.inbox },
      emailSent,
      smsSent,
      smsQueued,
      skipped: skippedExternal,
      reason: externalUnknown ? "Delivery outcome is unknown. Check the reminder history before trying again." :
        skippedExternal && inboxSent ? "Saved to PropLane inbox (external email/SMS not sent)." : undefined,
    }, { status: externalUnknown ? 409 : status === "pending" ? 202 : accepted ? 200 : 409 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
