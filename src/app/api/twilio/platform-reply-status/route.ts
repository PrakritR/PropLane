import { NextResponse } from "next/server";
import twilio from "twilio";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { twilioWebhookAuthToken } from "@/lib/twilio-client.server";
import { twilioStatusRank } from "@/lib/sms/delivery-status";
import { smsEnvelopeRuntime } from "@/lib/sms/inbound-envelope.server";
import { platformReplyCallbackUrl } from "@/lib/sms/platform-reply-dispatch.server";

export const runtime = "nodejs";
export async function POST(req: Request) {
 const requestUrl = new URL(req.url);
 const token = requestUrl.searchParams.get("token") ?? "";
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return new NextResponse(null, { status: 403 });
 const url = platformReplyCallbackUrl(token); const auth = twilioWebhookAuthToken();
 if (!url || !auth) return new NextResponse(null, { status: 503 });
 const expected = new URL(url);
 if (requestUrl.pathname !== expected.pathname || requestUrl.search !== expected.search) return new NextResponse(null, { status: 403 });
 const params = Object.fromEntries(new URLSearchParams(await req.text()));
 if (!twilio.validateRequest(auth, req.headers.get("x-twilio-signature") ?? "", url, params)) return new NextResponse(null, { status: 403 });
 const sid = params.MessageSid?.trim(); const account = params.AccountSid?.trim(); const status = params.MessageStatus?.trim().toLowerCase();
 const rank = twilioStatusRank(status);
 if (!sid || !account || account !== process.env.TWILIO_ACCOUNT_SID?.trim() || !params.From || !params.To || !rank) return new NextResponse(null, { status: 403 });
 const result = await createSupabaseServiceRoleClient().rpc("sms_platform_reply_callback", { p_token: token, p_runtime: smsEnvelopeRuntime(), p_account: account, p_from: params.From, p_to: params.To, p_sid: sid, p_status: status, p_rank: rank });
 if (result.error) return new NextResponse(null, { status: 503 });
 return new NextResponse(null, { status: result.data === true ? 204 : 403 });
}
