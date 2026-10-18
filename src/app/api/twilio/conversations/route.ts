import { NextResponse, after } from "next/server";
import { handleGroupMessage } from "@/lib/house-groups/ra.server";
import { verifyConversationsWebhook } from "@/lib/house-groups/webhook.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Twilio Conversations post-event webhook for HOUSE GROUP chats (group MMS). 1:1 texts stay on
 * `/api/twilio/inbound`; Conversations address autocreate is off, so only the per-conversation webhooks
 * this app registers reach here. Verify the signature, acknowledge at once, and do the work after the
 * response. A Twilio retry is a no-op: the handler dedupes on (group, MessageSid).
 */
export async function POST(req: Request) {
  const parsed = await verifyConversationsWebhook(req);
  if (!parsed.ok) {
    if (parsed.status === 200) return NextResponse.json({ ok: true });
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }
  const message = parsed.message;
  after(async () => {
    try {
      await handleGroupMessage(createSupabaseServiceRoleClient(), message);
    } catch (error) {
      // Masked: no phone number or message body reaches a log.
      console.error("house group message failed", error instanceof Error ? error.name : "unknown");
    }
  });
  return NextResponse.json({ ok: true });
}
