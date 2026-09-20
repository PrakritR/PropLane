import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sendVendorSponsoredOutbound } from "@/lib/vendor-sponsored-outbound.server";

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
  const recipientUserIds = Array.isArray(body.recipientUserIds)
    ? [...new Set(body.recipientUserIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))]
    : typeof body.recipientUserId === "string" ? [body.recipientUserId.trim()] : [];
  const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
  const wantsManagement = Array.isArray(body.broadcastCategories) && body.broadcastCategories.includes("management");
  if (!threadId && wantsManagement) {
    const { data: links } = await createSupabaseServiceRoleClient().from("manager_vendor_records")
      .select("manager_user_id").eq("vendor_user_id", access.actor.userId);
    recipientUserIds.push(...(links ?? []).map((row) => String(row.manager_user_id ?? "").trim()).filter(Boolean));
  }
  const wantsAdmin = body.includesAxisAdmin === true;
  if (!threadId && (recipientUserIds.length === 0 && !wantsAdmin || recipientUserIds.length > 20)) {
    return NextResponse.json({ ok: false, error: "Select up to 20 linked recipients." }, { status: 400 });
  }
  const db = createSupabaseServiceRoleClient();
  const requests = threadId ? [undefined] : [...recipientUserIds, ...(wantsAdmin ? ["__admin__"] : [])];
  const results = [];
  for (const recipientUserId of requests) {
    results.push(await sendVendorSponsoredOutbound(
      db,
      { userId: access.actor.userId, email: access.actor.email, name: access.actor.fullName },
      {
        channel,
        // Child keys make a bounded fan-out independently replayable without
        // ever merging two manager deliveries into one outbox operation.
        sendId: recipientUserId ? `${sendId}:${recipientUserId}` : sendId,
        subject: typeof body.subject === "string" ? body.subject : "",
        text: typeof body.text === "string" ? body.text : "",
        threadId,
        recipientUserId: recipientUserId === "__admin__" ? undefined : recipientUserId,
        recipientAdmin: recipientUserId === "__admin__",
      },
    ));
  }
  const result = results.find((candidate) => !candidate.ok) ?? results[0]!;
  if (result.ok) return NextResponse.json(result);
  const status = result.error === "conversation_unavailable" || result.error === "recipient_unlinked" ? 403 : result.error === "invalid_request" ? 400 : 409;
  return NextResponse.json({ ok: false, error: result.reason ?? result.error }, { status });
}
