import { NextResponse } from "next/server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { authorizePortalRecordShare } from "@/lib/portal-record-share-authorize.server";
import {
  buildPortalRecordShareUrl,
  createPortalRecordShareLink,
} from "@/lib/portal-record-share-links.server";
import {
  type RecordShareKind,
  recordShareEmailBody,
  recordShareEmailHtml,
  recordShareSmsText,
  recordShareSubject,
} from "@/lib/record-share-message";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { recordResidentProspectInboxMessage } from "@/lib/tour-notification-delivery.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";
import { resolveManagerWorkNumber } from "@/lib/twilio-provisioning";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Email and/or SMS a public view link for one lease or application. */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      kind?: string;
      recordId?: string;
      viaEmail?: boolean;
      viaSms?: boolean;
      to?: string;
      phone?: string;
      recipientName?: string;
      note?: string;
    };

    const kind: RecordShareKind | null =
      body.kind === "lease" || body.kind === "application" ? body.kind : null;
    const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    const viaSms = body.viaSms === true;
    const viaEmail = body.viaEmail !== false;
    const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
    const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
    // `normalizeE164` returns null for a number it cannot parse. Collapsing that to "" here is
    // what lets the `viaSms && !phone` guard below reject it — otherwise an unparseable number
    // slipped past as a non-empty value and reached the send.
    const phone = (phoneRaw ? normalizeE164(phoneRaw) : "") ?? "";

    if (!kind || !recordId) {
      return NextResponse.json({ error: "kind and recordId are required." }, { status: 400 });
    }
    if (!viaEmail && !viaSms) {
      return NextResponse.json({ error: "Choose email and/or SMS." }, { status: 400 });
    }
    if (viaEmail && !EMAIL_RE.test(to)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (viaSms && !phone) {
      return NextResponse.json({ error: "Enter a valid phone number for SMS." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const authz = await authorizePortalRecordShare(db, user.id, kind, recordId, "edit");
    if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status });

    const link = await createPortalRecordShareLink(db, {
      recordKind: kind,
      recordId: authz.canonicalRecordId,
      managerUserId: authz.recordOwnerUserId,
      createdBy: user.id,
      expiresInDays: 14,
    });
    const origin = resolveEmailLinkBaseUrl();
    const linkUrl = buildPortalRecordShareUrl(origin, kind, link.shareToken);
    const messageParams = {
      kind,
      recordTitle: authz.recordTitle,
      linkUrl,
      recipientName: typeof body.recipientName === "string" ? body.recipientName : undefined,
      managerNote: typeof body.note === "string" ? body.note : undefined,
    };
    const subject = recordShareSubject(kind, authz.recordTitle);
    const text = recordShareEmailBody(messageParams);
    const html = recordShareEmailHtml(messageParams);
    const smsText = recordShareSmsText(messageParams);

    let emailId: string | null = null;
    let emailSent = false;
    if (viaEmail) {
      const apiKey = process.env.RESEND_API_KEY?.trim();
      if (!apiKey) {
        return NextResponse.json({ error: "Email delivery is not configured." }, { status: 503 });
      }
      const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      const payload = (await res.json().catch(() => ({}))) as { message?: string; id?: string };
      if (!res.ok) {
        return NextResponse.json({ error: payload.message ?? "Could not send email." }, { status: 502 });
      }
      emailId = payload.id ?? null;
      emailSent = true;
      await recordResidentProspectInboxMessage(db, {
        participantEmail: to,
        subject,
        body: text,
        fromName: "PropLane",
        fromEmail: "invites@axis.local",
      });
    }

    if (viaSms) {
      const workNumber = await resolveManagerWorkNumber(db, user.id);
      if (!workNumber) {
        return NextResponse.json(
          { error: "No work number on this account yet. Finish SMS setup under Communication first.", emailSent },
          { status: 400 },
        );
      }
      const smsResult = await sendFromManagerWorkNumber({
        managerUserId: user.id,
        to: phone,
        text: smsText,
        fromNumber: workNumber,
        source: "work_number",
        counterpartyRole: "prospect",
      });
      if (!smsResult.ok) {
        return NextResponse.json(
          {
            error: smsResult.error === "recipient_opted_out" ? "That number has opted out of texts." : "Could not send SMS.",
            emailSent,
          },
          { status: 502 },
        );
      }
    }

    return NextResponse.json({ ok: true, id: emailId, linkUrl, viaEmail, viaSms });
  } catch {
    return NextResponse.json({ error: "Failed to send share link." }, { status: 500 });
  }
}
