import "server-only";

import twilio from "twilio";
import { twilioWebhookAuthToken } from "@/lib/twilio-client.server";
import { conversationsWebhookUrl } from "./conversations-gateway.server";
import type { GroupWebhookMessage } from "./ra.server";

export type ParsedGroupWebhook =
  | { ok: true; message: GroupWebhookMessage; eventType: string }
  | { ok: false; status: 200 | 400 | 403 | 503; error: string };

function mediaCount(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Verify and read one Twilio Conversations post-event webhook. The signature is checked against the
 * exact URL Twilio was given (`TWILIO_CONVERSATIONS_WEBHOOK_URL` when set) and the form params, and
 * it FAILS CLOSED: no signature on Vercel/production, or a signature that does not validate, is a 403
 * before anything is read or written. Only `onMessageAdded` carries work; any other event is acknowledged.
 */
export async function verifyConversationsWebhook(req: Request): Promise<ParsedGroupWebhook> {
  const authToken = twilioWebhookAuthToken();
  if (!authToken) return { ok: false, status: 503, error: "SMS not configured." };

  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw));
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const url = conversationsWebhookUrl().split("#")[0];
  const failClosed = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  if (!signature) {
    if (failClosed) return { ok: false, status: 403, error: "Invalid signature." };
  } else if (!twilio.validateRequest(authToken, signature, url, params)) {
    return { ok: false, status: 403, error: "Invalid signature." };
  }

  const eventType = String(params.EventType ?? "").trim();
  if (eventType !== "onMessageAdded") return { ok: false, status: 200, error: "ignored" };
  const conversationSid = String(params.ConversationSid ?? "").trim();
  const messageSid = String(params.MessageSid ?? "").trim();
  if (!/^CH[a-zA-Z0-9]{32}$/.test(conversationSid) || !messageSid) return { ok: false, status: 400, error: "Invalid event." };
  return {
    ok: true,
    eventType,
    message: {
      conversationSid,
      messageSid,
      author: String(params.Author ?? "").trim(),
      body: String(params.Body ?? ""),
      mediaCount: mediaCount(params.Media),
    },
  };
}
