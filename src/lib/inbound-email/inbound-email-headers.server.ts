import "server-only";

import { normalizeInboundHeaders } from "@/lib/inbound-email/inbound-sender-authentication";

/**
 * The raw message headers of a received email, from Resend's received-email
 * API (`headers` on the retrieve response). The `email.received` webhook is
 * metadata-only and carries none, so the authentication verdict has to be read
 * from here. Null on any failure (no key, non-2xx, no headers): callers treat
 * "unknown" as "not authenticated".
 */
export async function fetchResendReceivedEmailHeaders(
  emailId: string,
): Promise<Record<string, string[]> | null> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  const base = (process.env.RESEND_INBOUND_API_BASE?.trim() || "https://api.resend.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const data = (json.data && typeof json.data === "object" ? json.data : json) as Record<string, unknown>;
    const headers = normalizeInboundHeaders(data.headers);
    return Object.keys(headers).length ? headers : null;
  } catch {
    return null;
  }
}
