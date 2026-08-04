/**
 * Signed reply addresses for outbound portal conversation emails.
 *
 * Every conversation email gets a per-recipient `Reply-To` of the form
 *
 *   reply+<sender uuid hex>.<mac hex>@${RESEND_REPLY_DOMAIN}
 *
 * Both halves are lowercase hex ON PURPOSE: mail software (including our own
 * parseEmailAddress) freely lowercases address local parts, so a case-sensitive
 * encoding would be corrupted in transit.
 *
 * so an emailed reply comes back through Resend Inbound and can be routed into
 * the sender's portal thread. The MAC binds the PAIR (sender user id, recipient
 * email): a leaked address only lets mail be injected into that one thread, as
 * that one counterparty — the counterparty is re-derived from the reply's From
 * and verified against the MAC, and anything that fails verification falls
 * through to the admin support inbox instead of being trusted (or lost).
 *
 * Zero storage: both halves are recomputable, so no schema change and no token
 * table. Key material is RESEND_INBOUND_WEBHOOK_SECRET (already required for
 * inbound to work at all) with a domain-separated HMAC input. The feature is
 * dark until RESEND_REPLY_DOMAIN is set — buildReplyAddress returns null and no
 * token ever validates.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const REPLY_LOCAL_PREFIX = "reply+";
const MAC_INPUT_PREFIX = "email-reply:v1";
const MAC_LENGTH = 16; // hex chars = 64 bits — plenty for this threat model

function replyDomain(): string {
  return process.env.RESEND_REPLY_DOMAIN?.trim().toLowerCase() ?? "";
}

function secretKey(): Buffer | null {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  // Svix secrets are `whsec_<base64>`; use the decoded bytes like the
  // signature verifier does.
  return Buffer.from(secret.replace(/^whsec_/, ""), "base64");
}

function uuidToHex(uuid: string): string | null {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
}

function hexToUuid(hex: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pairMac(key: Buffer, senderUserId: string, recipientEmail: string): string {
  return createHmac("sha256", key)
    .update(`${MAC_INPUT_PREFIX}:${senderUserId.toLowerCase()}:${recipientEmail.trim().toLowerCase()}`, "utf8")
    .digest("hex")
    .slice(0, MAC_LENGTH);
}

/**
 * Reply address for one (sender, recipient) pair, or null when the feature is
 * dark (RESEND_REPLY_DOMAIN / secret unset) or the sender id is not a uuid.
 */
export function buildReplyAddress(senderUserId: string, recipientEmail: string): string | null {
  const domain = replyDomain();
  const key = secretKey();
  if (!domain || !key) return null;
  const encoded = uuidToHex(senderUserId);
  if (!encoded || !recipientEmail.includes("@")) return null;
  const local = `${REPLY_LOCAL_PREFIX}${encoded}.${pairMac(key, senderUserId, recipientEmail)}`;
  if (local.length > 64) return null; // RFC local-part bound; unreachable for uuid ids
  return `${local}@${domain}`;
}

/**
 * Find a valid reply token among an inbound email's To addresses and verify it
 * against the sender's From. Returns the token owner's user id (the portal user
 * whose thread the reply belongs to) or null when nothing verifies — callers
 * fall back to the admin support ingest.
 */
export function parseReplyAddress(
  toEmails: string[],
  fromEmail: string,
): { ownerUserId: string } | null {
  const domain = replyDomain();
  const key = secretKey();
  if (!domain || !key) return null;
  const from = fromEmail.trim().toLowerCase();
  if (!from.includes("@")) return null;

  for (const raw of toEmails) {
    const address = raw.trim().toLowerCase();
    const at = address.lastIndexOf("@");
    if (at <= 0 || address.slice(at + 1) !== domain) continue;
    const local = address.slice(0, at);
    if (!local.startsWith(REPLY_LOCAL_PREFIX)) continue;
    const [encoded, mac] = local.slice(REPLY_LOCAL_PREFIX.length).split(".");
    if (!encoded || !mac || mac.length !== MAC_LENGTH) continue;
    const ownerUserId = hexToUuid(encoded);
    if (!ownerUserId) continue;
    const expected = Buffer.from(pairMac(key, ownerUserId, from), "utf8");
    const provided = Buffer.from(mac, "utf8");
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return { ownerUserId };
    }
  }
  return null;
}

/**
 * Deterministic synthetic anchor shared by every conversation email for one
 * (sender, recipient) pair, set as References/In-Reply-To so the recipient's
 * mail client groups the back-and-forth without us persisting any Message-ID
 * chain (the GitHub-notifications pattern).
 */
export function conversationAnchorMessageId(
  senderUserId: string,
  recipientEmail: string,
  fromDomain: string,
): string {
  const digest = createHmac("sha256", "pl-anchor")
    .update(`${senderUserId.toLowerCase()}:${recipientEmail.trim().toLowerCase()}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `<pl-anchor-${digest}@${fromDomain}>`;
}

/*
 * SMS-conversation reply addresses.
 *
 * An inbound text notification emailed to a manager carries a Reply-To of the
 * form
 *
 *   sms+<manager uuid hex><counterparty 10-digit US phone>.<mac hex>@${RESEND_REPLY_DOMAIN}
 *
 * so the manager can answer the text FROM THEIR MAIL CLIENT: the reply comes
 * back through Resend Inbound, the token resolves the (manager, counterparty
 * phone) SMS conversation, and the body is sent onward as an SMS from the
 * manager's work number. The MAC binds the TRIPLE (manager id, counterparty
 * phone, manager email): it only verifies when the reply's From is the exact
 * manager email the notification was sent to, so a leaked address lets mail be
 * injected into that one conversation only by someone who can also send as the
 * manager's own address. Same zero-storage posture as the portal reply token
 * above; dark until RESEND_REPLY_DOMAIN is set.
 *
 * Local-part budget (RFC 64): "sms+" (4) + 32 uuid hex + 10 digits + "." +
 * 16 mac = 63. US-national 10-digit phones only — a number that does not
 * normalize to one gets no token (the notification email still sends, just
 * without an email-reply path).
 */
const SMS_REPLY_LOCAL_PREFIX = "sms+";
const SMS_MAC_INPUT_PREFIX = "sms-reply:v1";
const UUID_HEX_LENGTH = 32;
const US_NATIONAL_DIGITS = 10;

/** 10-digit US national number, or null when the input is not US-shaped. */
function usNationalDigits(phone: string): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === US_NATIONAL_DIGITS) return digits;
  if (digits.length === US_NATIONAL_DIGITS + 1 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

function smsPairMac(
  key: Buffer,
  managerUserId: string,
  phone10: string,
  managerEmail: string,
): string {
  return createHmac("sha256", key)
    .update(
      `${SMS_MAC_INPUT_PREFIX}:${managerUserId.toLowerCase()}:${phone10}:${managerEmail.trim().toLowerCase()}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, MAC_LENGTH);
}

/**
 * Reply address for one (manager, counterparty phone) SMS conversation, bound
 * to the manager email the notification is addressed to. Null when the feature
 * is dark, the manager id is not a uuid, or the phone is not a US number.
 */
export function buildSmsReplyAddress(
  managerUserId: string,
  managerEmail: string,
  counterpartyPhone: string,
): string | null {
  const domain = replyDomain();
  const key = secretKey();
  if (!domain || !key) return null;
  const encoded = uuidToHex(managerUserId);
  const phone10 = usNationalDigits(counterpartyPhone);
  if (!encoded || !phone10 || !managerEmail.includes("@")) return null;
  const local = `${SMS_REPLY_LOCAL_PREFIX}${encoded}${phone10}.${smsPairMac(key, managerUserId, phone10, managerEmail)}`;
  if (local.length > 64) return null; // RFC local-part bound; unreachable for uuid ids
  return `${local}@${domain}`;
}

/**
 * Find a valid SMS-conversation reply token among an inbound email's To
 * addresses and verify it against the sender's From. Returns the conversation
 * identity (manager + counterparty phone as E.164) or null when nothing
 * verifies — callers fall back to the portal reply token, then the admin
 * support ingest.
 */
export function parseSmsReplyAddress(
  toEmails: string[],
  fromEmail: string,
): { managerUserId: string; counterpartyPhone: string } | null {
  const domain = replyDomain();
  const key = secretKey();
  if (!domain || !key) return null;
  const from = fromEmail.trim().toLowerCase();
  if (!from.includes("@")) return null;

  for (const raw of toEmails) {
    const address = raw.trim().toLowerCase();
    const at = address.lastIndexOf("@");
    if (at <= 0 || address.slice(at + 1) !== domain) continue;
    const local = address.slice(0, at);
    if (!local.startsWith(SMS_REPLY_LOCAL_PREFIX)) continue;
    const [payload, mac] = local.slice(SMS_REPLY_LOCAL_PREFIX.length).split(".");
    if (!payload || !mac || mac.length !== MAC_LENGTH) continue;
    if (payload.length !== UUID_HEX_LENGTH + US_NATIONAL_DIGITS) continue;
    const managerUserId = hexToUuid(payload.slice(0, UUID_HEX_LENGTH));
    const phone10 = payload.slice(UUID_HEX_LENGTH);
    if (!managerUserId || !/^\d{10}$/.test(phone10)) continue;
    const expected = Buffer.from(smsPairMac(key, managerUserId, phone10, from), "utf8");
    const provided = Buffer.from(mac, "utf8");
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return { managerUserId, counterpartyPhone: `+1${phone10}` };
    }
  }
  return null;
}

/**
 * Per-(manager, counterparty phone) threading anchor so consecutive text
 * notifications group into ONE conversation in the manager's mail client —
 * the SMS twin of {@link conversationAnchorMessageId}.
 */
export function smsConversationAnchorMessageId(
  managerUserId: string,
  counterpartyPhone: string,
  fromDomain: string,
): string {
  const phone10 = usNationalDigits(counterpartyPhone) ?? counterpartyPhone.replace(/\D/g, "");
  const digest = createHmac("sha256", "pl-sms-anchor")
    .update(`${managerUserId.toLowerCase()}:${phone10}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `<pl-sms-anchor-${digest}@${fromDomain}>`;
}

/*
 * Portal-only SMS notification reply addresses (co-manager copies).
 *
 * Co-managers are notified of inbound texts but must NOT get a sendable `sms+`
 * token — a reply from their address would text the prospect from the
 * co-manager's own work number (wrong From, wrong thread). Instead their
 * notification carries a `smsp+` Reply-To that verifies the same triple but
 * NEVER sends: the inbound webhook bounces with a portal pointer. Distinct
 * prefix from `sms+` so a forged or leaked send token cannot be confused with
 * a portal-only bounce address.
 *
 * Local-part budget: "smsp+" (5) + 32 uuid hex + 10 digits + "." + 16 mac = 64.
 */
const SMS_PORTAL_LOCAL_PREFIX = "smsp+";
const SMS_PORTAL_MAC_INPUT_PREFIX = "sms-portal-reply:v1";

function smsPortalPairMac(
  key: Buffer,
  managerUserId: string,
  phone10: string,
  managerEmail: string,
): string {
  return createHmac("sha256", key)
    .update(
      `${SMS_PORTAL_MAC_INPUT_PREFIX}:${managerUserId.toLowerCase()}:${phone10}:${managerEmail.trim().toLowerCase()}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, MAC_LENGTH);
}

/**
 * Reply-To for a co-manager's inbound-text notification. Verifies, but the
 * inbound path ONLY bounces — it never sends an SMS.
 */
export function buildSmsPortalOnlyReplyAddress(
  managerUserId: string,
  managerEmail: string,
  counterpartyPhone: string,
): string | null {
  const domain = replyDomain();
  const key = secretKey();
  if (!domain || !key) return null;
  const encoded = uuidToHex(managerUserId);
  const phone10 = usNationalDigits(counterpartyPhone);
  if (!encoded || !phone10 || !managerEmail.includes("@")) return null;
  const local = `${SMS_PORTAL_LOCAL_PREFIX}${encoded}${phone10}.${smsPortalPairMac(key, managerUserId, phone10, managerEmail)}`;
  if (local.length > 64) return null;
  return `${local}@${domain}`;
}

/**
 * Find a verified portal-only (`smsp+`) address among the inbound To list.
 * Callers bounce with a portal pointer — never send SMS.
 */
export function parseSmsPortalOnlyReplyAddress(
  toEmails: string[],
  fromEmail: string,
): { managerUserId: string; counterpartyPhone: string } | null {
  const domain = replyDomain();
  const key = secretKey();
  if (!domain || !key) return null;
  const from = fromEmail.trim().toLowerCase();
  if (!from.includes("@")) return null;

  for (const raw of toEmails) {
    const address = raw.trim().toLowerCase();
    const at = address.lastIndexOf("@");
    if (at <= 0 || address.slice(at + 1) !== domain) continue;
    const local = address.slice(0, at);
    if (!local.startsWith(SMS_PORTAL_LOCAL_PREFIX)) continue;
    const [payload, mac] = local.slice(SMS_PORTAL_LOCAL_PREFIX.length).split(".");
    if (!payload || !mac || mac.length !== MAC_LENGTH) continue;
    if (payload.length !== UUID_HEX_LENGTH + US_NATIONAL_DIGITS) continue;
    const managerUserId = hexToUuid(payload.slice(0, UUID_HEX_LENGTH));
    const phone10 = payload.slice(UUID_HEX_LENGTH);
    if (!managerUserId || !/^\d{10}$/.test(phone10)) continue;
    const expected = Buffer.from(smsPortalPairMac(key, managerUserId, phone10, from), "utf8");
    const provided = Buffer.from(mac, "utf8");
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return { managerUserId, counterpartyPhone: `+1${phone10}` };
    }
  }
  return null;
}
