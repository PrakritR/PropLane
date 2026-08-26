import twilio, { type Twilio } from "twilio";

/**
 * Restricted API keys are preferred for REST mutations. The Auth Token stays
 * available because Twilio webhook signatures require it. Production REST
 * operations fail closed unless the restricted key pair is complete.
 */
export function createTwilioRestClient(): Twilio | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  if (!accountSid) return null;
  const keySid = process.env.TWILIO_API_KEY_SID?.trim();
  const keySecret = process.env.TWILIO_API_KEY_SECRET?.trim();
  if (keySid && keySecret) return twilio(keySid, keySecret, { accountSid });
  if (keySid || keySecret) return null;
  if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
    return null;
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  return authToken ? twilio(accountSid, authToken) : null;
}

export function twilioWebhookAuthToken(): string | null {
  return process.env.TWILIO_AUTH_TOKEN?.trim() || null;
}

/**
 * Resolve Twilio's immutable creation time for an inbound message. Webhook
 * delivery time is not message order: a retry can arrive after a newer STOP.
 * Control-keyword handling therefore uses this provider-grounded timestamp.
 */
export async function fetchTwilioMessageCreatedAt(messageSid: string): Promise<string | null> {
  const sid = messageSid.trim();
  if (!/^SM[a-fA-F0-9]{32}$/.test(sid)) return null;
  const client = createTwilioRestClient();
  if (!client) return null;
  try {
    const message = await client.messages(sid).fetch();
    const created = message.dateCreated;
    if (!(created instanceof Date) || Number.isNaN(created.getTime())) return null;
    return created.toISOString();
  } catch {
    return null;
  }
}
