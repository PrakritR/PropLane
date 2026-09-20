import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sendVendorSponsoredOutbound } from "@/lib/vendor-sponsored-outbound.server";
import { normalizeInboxAttachmentUrls } from "@/lib/inbox-attachments.server";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Contract for VendorInboxPanel: send one channel at a time with either the
 * existing threadId or a profile-backed recipientUserId.  It deliberately
 * accepts no toEmail/toPhone/from fields.
 */
export async function POST(req: Request) {
  const access = await requireVendorApiAccess();
  if (!access.ok) return NextResponse.json({ ok: false, error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const channel = body.channel === "email" || body.channel === "sms" ? body.channel : null;
  const sendId = typeof body.sendId === "string" ? body.sendId.trim().toLowerCase() : "";
  if (!channel || !UUID.test(sendId)) return NextResponse.json({ ok: false, error: "Invalid message request." }, { status: 400 });
  const requestedRecipientUserIds = Array.isArray(body.recipientUserIds)
    ? [...new Set(body.recipientUserIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))]
    : typeof body.recipientUserId === "string" ? [body.recipientUserId.trim()] : [];
  const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
  const wantsManagement = Array.isArray(body.broadcastCategories) && body.broadcastCategories.includes("management");
  if (!threadId && wantsManagement) {
    const { data: links, error: linksError } = await createSupabaseServiceRoleClient().from("manager_vendor_records")
      .select("manager_user_id").eq("vendor_user_id", access.actor.userId);
    // Management broadcast is all-or-none. A failed expansion must not quietly
    // degrade to an admin-only or partial recipient set.
    if (linksError) return NextResponse.json({ ok: false, error: "Could not resolve management recipients." }, { status: 503 });
    requestedRecipientUserIds.push(...(links ?? []).map((row) => String(row.manager_user_id ?? "").trim()).filter(Boolean));
  }
  const wantsAdmin = body.includesAxisAdmin === true;
  // Broadcast expansion happens before this final canonical dedupe and cap.
  const recipientUserIds = [...new Set(requestedRecipientUserIds.filter(Boolean))];
  const recipientKeys = [...recipientUserIds, ...(wantsAdmin ? ["__admin__"] : [])];
  if (!threadId && ((recipientKeys.length === 0) || recipientKeys.length > 20)) {
    return NextResponse.json({ ok: false, error: "Select up to 20 linked recipients." }, { status: 400 });
  }
  const db = createSupabaseServiceRoleClient();
  const requests = threadId ? [undefined] : recipientKeys;
  const shared = {
    channel: channel as "email" | "sms",
    subject: typeof body.subject === "string" ? body.subject : "",
    text: typeof body.text === "string" ? body.text : "",
    threadId,
    attachmentUrls: normalizeInboxAttachmentUrls(Array.isArray(body.attachmentUrls) ? body.attachmentUrls : [], access.actor.userId),
  };
  const buildRequest = (recipientUserId: string | undefined, preflight = false) => ({
    ...shared,
    // A stable child key means a retry has the same per-recipient outbox fence.
    sendId: recipientUserId ? `${sendId}:${recipientUserId}` : sendId,
    recipientUserId: recipientUserId === "__admin__" ? undefined : recipientUserId,
    recipientAdmin: recipientUserId === "__admin__",
    preflight,
  });
  // Refuse the entire fanout before the first provider/outbox side effect.
  const preflight = [];
  for (const recipientUserId of requests) {
    preflight.push(await sendVendorSponsoredOutbound(
      db,
      { userId: access.actor.userId, email: access.actor.email, name: access.actor.fullName },
      buildRequest(recipientUserId, true),
    ));
  }
  const refused = preflight.find((candidate) => !candidate.ok);
  if (refused && !refused.ok) {
    const status = refused.error === "conversation_unavailable" || refused.error === "recipient_unlinked" ? 403 : refused.error === "invalid_request" ? 400 : 409;
    // A preflight failure prevents every child from being attempted. The
    // successful preflights are also refused, rather than pretending they were
    // delivered, while the failing child carries the durable refusal reason.
    return NextResponse.json({ ok: false, error: refused.reason ?? refused.error, results: preflight.map((result, index) => ({ recipient: requests[index] ?? "thread", state: "refused", ...(result.ok ? {} : { reason: result.reason ?? result.error }) })) }, { status });
  }
  const results = [];
  for (const recipientUserId of requests) {
    results.push(await sendVendorSponsoredOutbound(db, { userId: access.actor.userId, email: access.actor.email, name: access.actor.fullName }, buildRequest(recipientUserId)));
  }
  const childResults = results.map((result, index) => ({ recipient: requests[index] ?? "thread", state: result.ok ? result.delivery : "refused", ...(result.ok ? {} : { reason: result.reason ?? result.error }) }));
  const deliveries = results.filter((result): result is Extract<typeof result, { ok: true }> => result.ok).map((result) => result.delivery);
  const delivery = deliveries.length === 0 ? "refused" : new Set(deliveries).size === 1 ? deliveries[0] : "mixed";
  const failure = results.find((result) => !result.ok);
  if (failure && !failure.ok) return NextResponse.json({ ok: false, error: failure.reason ?? failure.error, delivery, results: childResults }, { status: 409 });
  return NextResponse.json({ ok: true, delivery, results: childResults });
}
