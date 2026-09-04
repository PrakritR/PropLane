/**
 * The one Resend sender for portal CONVERSATION emails (interactive and
 * scheduled inbox messages). Each recipient gets their own personalized
 * payload — never a shared `to:` array, which used to leak every broadcast
 * recipient's address to every other — carrying:
 *
 *   • `reply_to`: the pair-signed reply address (reply-address.server.ts), so
 *     an emailed reply routes back into the sender's portal thread via the
 *     inbound webhook. Absent when RESEND_REPLY_DOMAIN is unset.
 *   • `In-Reply-To`/`References`: a deterministic per-pair anchor so
 *     consecutive portal emails group into one conversation in the
 *     recipient's mail client with no persisted Message-ID chain.
 *
 * One recipient goes through POST /emails; more go through POST /emails/batch
 * in chunks of 100 (the batch cap), keeping a broadcast at ~1 HTTP call under
 * Resend's low request rate limit. Attachments are unsupported on batch and
 * unused here. Notification emails (reminders, invites, …) still use their own
 * inline sends — extend them onto this helper deliberately, not by default.
 */
import {
  buildReplyAddress,
  conversationAnchorMessageId,
} from "@/lib/inbound-email/reply-address.server";

const RESEND_BATCH_LIMIT = 100;
const DEFAULT_FROM = "PropLane <onboarding@resend.dev>";

export type ConversationEmailResult = { sent: boolean; resendId: string | null };

/** Domain of the From address ("PropLane <x@y>" or bare) — anchors live under it. */
function fromDomain(from: string): string {
  const email = from.match(/<([^>]+)>/)?.[1] ?? from;
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "prop-lane.space";
}

/**
 * Send one conversation email per recipient. Never throws — a failed request
 * (or a missing RESEND_API_KEY) marks its recipients unsent so callers keep
 * their existing "inbox already written, email is best-effort" behavior.
 */
export async function sendPortalConversationEmails(opts: {
  senderUserId: string;
  toEmails: string[];
  subject: string;
  text: string;
  html: string;
  /**
   * The sending manager's own work email, when they have one. Their mail then carries their
   * identity instead of the shared PropLane sender, and a reply lands in their assistant
   * inbox rather than a synthetic address. Omitted or empty keeps the shared sender.
   */
  fromAddress?: string | null;
}): Promise<Map<string, ConversationEmailResult>> {
  const results = new Map<string, ConversationEmailResult>(
    opts.toEmails.map((email) => [email, { sent: false, resendId: null }]),
  );
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey || opts.toEmails.length === 0) return results;
  // The manager's own work email wins when they have one; the shared sender is the fallback
  // for managers who have not set one up and for every non-manager sender.
  const from = opts.fromAddress?.trim() || process.env.RESEND_FROM?.trim() || DEFAULT_FROM;
  const domain = fromDomain(from);

  const payloads = opts.toEmails.map((email) => {
    const anchor = conversationAnchorMessageId(opts.senderUserId, email, domain);
    const replyTo = buildReplyAddress(opts.senderUserId, email);
    return {
      email,
      body: {
        from,
        to: [email],
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
        ...(replyTo ? { reply_to: replyTo } : {}),
        headers: { "In-Reply-To": anchor, References: anchor },
      },
    };
  });

  async function send(url: string, body: unknown): Promise<unknown | null> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Distinguish a payload-shape rejection (e.g. batch refusing a field)
        // from a transient blip — without this, every broadcast failing would
        // look identical to a network hiccup.
        const detail = await res.text().catch(() => "");
        console.warn("portal email send failed", res.status, detail.slice(0, 500));
        return null;
      }
      return (await res.json().catch(() => ({}))) as unknown;
    } catch {
      return null;
    }
  }

  if (payloads.length === 1) {
    const only = payloads[0]!;
    const json = await send("https://api.resend.com/emails", only.body);
    if (json !== null) {
      const id = (json as { id?: string }).id ?? null;
      results.set(only.email, { sent: true, resendId: id });
    }
    return results;
  }

  for (let start = 0; start < payloads.length; start += RESEND_BATCH_LIMIT) {
    const chunk = payloads.slice(start, start + RESEND_BATCH_LIMIT);
    const json = await send(
      "https://api.resend.com/emails/batch",
      chunk.map((p) => p.body),
    );
    if (json === null) continue; // whole chunk failed — recipients stay unsent
    const ids = (json as { data?: Array<{ id?: string }> }).data ?? [];
    chunk.forEach((p, i) => {
      results.set(p.email, { sent: true, resendId: ids[i]?.id ?? null });
    });
  }
  return results;
}
