import { NextResponse } from "next/server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { publicServiceProjection } from "@/lib/public-service-projection";
import { readRosterVendorTextStatus, sendManagerConversationSms } from "@/lib/manager-sms-send.server";
import { ensureVendorForOutboundText } from "@/lib/sms/inbound-text-routing.server";
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
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

export const runtime = "nodejs";

/**
 * Text a service to a vendor's phone (vendor-work-share-1006). Modeled on
 * `/api/portal/record-share-link/send`: the manager is re-derived from the session, ownership of the
 * service is re-derived from the row (never the body), the phone is normalized, a hashed-token link
 * is minted, and the text goes out from the workspace's work number through the existing
 * vendor-texting path the manager compose uses (`sendManagerConversationSms` for a roster vendor): the number is
 * added to (or matched on) the Vendors list, the first text needs the "I work with this vendor" attestation and
 * carries the identification + STOP line, and the text is projected into the manager's vendor thread.
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

    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    if (!serviceIsOpenToNewRequests(record, row)) {
      return NextResponse.json({ error: "This service already has a vendor." }, { status: 409 });
    }

    const sharePhotos = body.sharePhotos === true;
    const { data: profile } = await db.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
    const managerName = typeof profile?.full_name === "string" ? profile.full_name.trim() : "";
    const view = publicServiceProjection({ ...row, publishSharePhotos: sharePhotos }, managerName);

    // The number joins the manager's Vendors list (or is matched to the vendor already there): the text is
    // a vendor-texting send like any other, so it carries the first-text attestation, the identification +
    // STOP line, the vendor_conversation consent evidence, credit reservation and the thread projection.
    const recipientName = typeof body.recipientName === "string" ? body.recipientName.trim().slice(0, 80) : "";
    const vendor = await ensureVendorForOutboundText(db, {
      managerUserId: user.id,
      toPhone: phone,
      body: "",
      markedVendor: true,
      name: recipientName || undefined,
      trade: view.trade,
    });
    if (!vendor) return NextResponse.json({ error: "Could not add this number to your vendors." }, { status: 500 });
    const status = await readRosterVendorTextStatus(db, { actorUserId: user.id, vendorRecordId: vendor.vendorId });
    if (status.status < 200 || status.status >= 300) return NextResponse.json(status.body, { status: status.status });
    if (status.body.optedOut === true) {
      return NextResponse.json({ error: "That number has opted out of texts." }, { status: 409 });
    }
    const attested = body.attestWorksWithVendor === true;
    if (status.body.needsAttestation === true && !attested) {
      return NextResponse.json(
        {
          code: "vendor_attestation_required",
          error: "Confirm that you work with this vendor to send the first text.",
          senderLine: typeof status.body.senderLine === "string" ? status.body.senderLine : undefined,
        },
        { status: 409 },
      );
    }

    const sandbox = process.env.NODE_ENV === "development" && process.env.SERVICE_LINK_SMS_SANDBOX === "1";

    // Counted before anything is minted or sent: a manager over the daily cap sends nothing.
    if (!(await consumeServiceShareSmsAllowance(user.id))) {
      return NextResponse.json({ error: "You've reached today's limit for texting services. Try again tomorrow." }, { status: 429 });
    }

    const { link, token } = await createServiceShareLink(db, {
      workOrderId,
      managerUserId: user.id,
      createdBy: user.id,
      recipientPhone: phone,
      recipientName: recipientName || null,
      sharePhotos,
    });
    const linkUrl = buildServiceShareUrl(resolveEmailLinkBaseUrl(), token);
    const text = serviceShareSmsText({
      recipientName,
      managerName,
      trade: view.trade,
      area: view.area,
      title: view.title,
      linkUrl,
    });

    const send = (runDispatch?: Parameters<typeof sendManagerConversationSms>[1]["runDispatch"]) =>
      sendManagerConversationSms(db, {
        actorUserId: user.id,
        toPhone: phone,
        text,
        vendorRecordId: vendor.vendorId,
        attestVendorRelationship: attested,
        runDispatch,
      });
    let outcome: { result: Awaited<ReturnType<typeof send>>; effects: unknown[] };
    if (sandbox) {
      // The text is queued for real (so it lands in the manager's vendor thread) but the carrier hand-off
      // is captured: nothing is delivered.
      const identity = { actorUserId: user.id, managerUserId: user.id, appOrigin: resolveEmailLinkBaseUrl() };
      const effects: unknown[] = [];
      let result = await send(async (run) => {
        const captured = await runWithSmsTestTransport(identity, run);
        effects.push(...captured.effects);
        return captured.result;
      });
      // A dev account with no ready work line cannot queue for real: capture the whole send instead.
      if (result.status < 200 || result.status >= 300) {
        const captured = await runWithSmsTestTransport(identity, () => send());
        result = captured.result;
        effects.push(...captured.effects);
      }
      outcome = { result, effects };
    } else {
      outcome = { result: await send(), effects: [] };
    }

    if (outcome.result.status < 200 || outcome.result.status >= 300) {
      // Nothing reached the vendor, so the link must not stay live.
      await db.from("service_share_links").update({ revoked_at: new Date().toISOString() }).eq("id", link.id);
      return NextResponse.json(outcome.result.body, { status: outcome.result.status });
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
