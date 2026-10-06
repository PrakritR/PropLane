import { NextResponse } from "next/server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { publicServiceProjection } from "@/lib/public-service-projection";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import {
  buildServiceShareUrl,
  consumeServiceShareSmsAllowance,
  createServiceShareLink,
  markServiceShareLinkTexted,
  revokeServiceShareLinks,
} from "@/lib/service-share-links.server";
import { serviceShareSmsText } from "@/lib/service-share-message";
import { serviceIsOpenToNewRequests } from "@/lib/service-work-board.server";
import { runWithSmsTestTransport } from "@/lib/sms/sms-test-transport.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";
import { resolveManagerWorkNumber } from "@/lib/twilio-provisioning";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

export const runtime = "nodejs";

/**
 * Text a service to a vendor's phone (vendor-work-share-1006). Modeled on
 * `/api/portal/record-share-link/send`: the manager is re-derived from the session, ownership of the
 * service is re-derived from the row (never the body), the phone is normalized, a hashed-token link
 * is minted, and the text goes out from the workspace's work number through the existing
 * `sendFromManagerWorkNumber` - consent, quiet hours and STOP are that path's, untouched here.
 *
 * Local sandbox: with `SERVICE_LINK_SMS_SANDBOX=1` under `next dev`, the send runs inside the SMS test
 * transport, which CAPTURES the text instead of delivering it, and the route answers with what would
 * have been sent. It cannot be switched on in a deployed build.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind !== "normal") {
      return NextResponse.json({ error: "Service links are unavailable for this account." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      workOrderId?: string;
      phone?: string;
      recipientName?: string;
      sharePhotos?: boolean;
      attestWorksWithVendor?: boolean;
      revoke?: boolean;
    };
    const workOrderId = typeof body.workOrderId === "string" ? body.workOrderId.trim() : "";
    if (!workOrderId) return NextResponse.json({ error: "workOrderId is required." }, { status: 400 });

    const { data: record } = await db
      .from("portal_work_order_records")
      .select("id, manager_user_id, vendor_user_id, row_data")
      .eq("id", workOrderId)
      .maybeSingle();
    // Ownership is the record's, never the caller's claim; a missing row and someone else's row read the same.
    if (!record || record.manager_user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    if (body.revoke === true) {
      const revoked = await revokeServiceShareLinks(db, { workOrderId, managerUserId: user.id });
      return NextResponse.json({ ok: true, revoked });
    }

    const phone = typeof body.phone === "string" && body.phone.trim() ? (normalizeE164(body.phone.trim()) ?? "") : "";
    if (!phone) return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
    if (body.attestWorksWithVendor !== true) {
      return NextResponse.json({ error: "Confirm that you work with this vendor." }, { status: 400 });
    }

    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    if (!serviceIsOpenToNewRequests(record, row)) {
      return NextResponse.json({ error: "This service already has a vendor." }, { status: 409 });
    }

    const sandbox = process.env.NODE_ENV === "development" && process.env.SERVICE_LINK_SMS_SANDBOX === "1";
    // Never provisions a number in the sandbox: resolving one can buy a real line.
    let workNumber: string | null;
    if (sandbox) {
      const { data: profileRow } = await db.from("profiles").select("sms_from_number").eq("id", user.id).maybeSingle();
      workNumber = String(profileRow?.sms_from_number ?? "").trim() || "sandbox";
    } else {
      workNumber = await resolveManagerWorkNumber(db, user.id);
    }
    if (!workNumber) {
      return NextResponse.json(
        { error: "No work number on this account yet. Finish SMS setup under Communication first." },
        { status: 400 },
      );
    }

    // Counted before anything is minted or sent: a manager over the daily cap sends nothing.
    if (!(await consumeServiceShareSmsAllowance(user.id))) {
      return NextResponse.json({ error: "You've reached today's limit for texting services. Try again tomorrow." }, { status: 429 });
    }

    const sharePhotos = body.sharePhotos === true;
    const { data: profile } = await db.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
    const managerName = typeof profile?.full_name === "string" ? profile.full_name.trim() : "";
    const { link, token } = await createServiceShareLink(db, {
      workOrderId,
      managerUserId: user.id,
      createdBy: user.id,
      recipientPhone: phone,
      recipientName: typeof body.recipientName === "string" ? body.recipientName : null,
      sharePhotos,
    });
    const linkUrl = buildServiceShareUrl(resolveEmailLinkBaseUrl(), token);
    const view = publicServiceProjection({ ...row, publishSharePhotos: sharePhotos }, managerName);
    const text = serviceShareSmsText({
      recipientName: body.recipientName,
      managerName,
      trade: view.trade,
      area: view.area,
      title: view.title,
      linkUrl,
    });

    const send = () =>
      sendFromManagerWorkNumber({
        managerUserId: user.id,
        to: phone,
        text,
        fromNumber: workNumber,
        source: "work_number",
        counterpartyRole: "vendor",
      });
    const outcome = sandbox
      ? await runWithSmsTestTransport({ actorUserId: user.id, managerUserId: user.id, appOrigin: resolveEmailLinkBaseUrl() }, send)
      : { result: await send(), effects: [] };

    if (!outcome.result.ok) {
      // Nothing reached the vendor, so the link must not stay live.
      await db.from("service_share_links").update({ revoked_at: new Date().toISOString() }).eq("id", link.id);
      const refused = outcome.result.error === "recipient_opted_out";
      return NextResponse.json(
        { error: refused ? "That number has opted out of texts." : "Could not send the text." },
        { status: refused ? 409 : 502 },
      );
    }
    await markServiceShareLinkTexted(db, link.id);

    return NextResponse.json({
      ok: true,
      expiresAt: link.expiresAt,
      ...(sandbox ? { sandbox: { to: phone, text, link: linkUrl, captured: outcome.effects.length } } : {}),
    });
  } catch (e) {
    const message = e instanceof Error && /unavailable|live links/.test(e.message) ? e.message : "Failed to send the service.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
