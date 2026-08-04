/**
 * Single-use grants for the emailed-SMS-reply path.
 *
 * The `sms+` token is zero-storage and verifies against the reply's `From`
 * header alone, which an attacker can spoof. When the receiving MTA gave us no
 * authentication verdict to check (`email-authentication.ts` → `unknown`, the
 * common case on Resend inbound), the token by itself is therefore not enough
 * to send a real text from a manager's business number.
 *
 * A grant narrows the window to what the product actually promises: ONE emailed
 * reply per notification email. Every inbound-text notification refreshes the
 * grant; the ingest consumes it before sending. A replayed, forwarded, or
 * forged reply arriving after the manager already answered — or against a
 * conversation that never notified them — finds nothing to consume and bounces.
 *
 * Stored in `portal_outbound_mail_records` (the same side table the send claim
 * uses) keyed on (manager, counterparty phone), so it needs no migration and a
 * re-notification is a plain upsert.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "portal_outbound_mail_records";

/** A grant outlives a weekend of unread mail but not an old forwarded thread. */
export const SMS_REPLY_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 10-digit US national number — the same identity the `sms+` token encodes. */
function usNationalDigits(phone: string): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

export function smsReplyGrantRecordId(
  managerUserId: string,
  counterpartyPhone: string,
): string | null {
  const manager = String(managerUserId ?? "").trim().toLowerCase();
  const phone10 = usNationalDigits(counterpartyPhone);
  if (!manager || !phone10) return null;
  return `sms_reply_grant_${manager}_${phone10}`;
}

/** Per-conversation rate-limit key, shared by every caller so it cannot drift. */
export function smsEmailReplyRateLimitKey(
  managerUserId: string,
  counterpartyPhone: string,
): string {
  const phone10 = usNationalDigits(counterpartyPhone) ?? String(counterpartyPhone ?? "").replace(/\D/g, "");
  return `sms-email-reply:${String(managerUserId ?? "").trim().toLowerCase()}:${phone10}`;
}

/**
 * Open (or re-open) the reply window for this conversation. Called after a
 * notification email carrying the reply token actually went out — a grant with
 * no token in anyone's inbox would only widen the window for a forger.
 */
export async function grantSmsEmailReply(
  db: SupabaseClient,
  args: { managerUserId: string; counterpartyPhone: string; managerEmail: string },
): Promise<boolean> {
  const id = smsReplyGrantRecordId(args.managerUserId, args.counterpartyPhone);
  if (!id) return false;
  const { error } = await db.from(TABLE).upsert(
    {
      id,
      recipient_email: args.managerEmail,
      subject: "SMS email-reply grant",
      channel: "sms",
      row_data: {
        id,
        kind: "sms_reply_grant",
        managerUserId: args.managerUserId,
        to: args.counterpartyPhone,
        grantedAt: new Date().toISOString(),
        consumedAt: null,
      },
    },
    { onConflict: "id" },
  );
  return !error;
}

export type SmsReplyGrantConsumption =
  | { ok: true }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "unreadable" };

/**
 * Spend the grant for this conversation. Fails CLOSED on an unreadable row:
 * this is the authorization gate for a spoofable channel, so "we could not
 * check" must refuse (the manager is told to reply in the portal) rather than
 * fall open the way the plan/consent gates deliberately do.
 */
export async function consumeSmsEmailReplyGrant(
  db: SupabaseClient,
  args: { managerUserId: string; counterpartyPhone: string },
  nowMs: number = Date.now(),
): Promise<SmsReplyGrantConsumption> {
  const id = smsReplyGrantRecordId(args.managerUserId, args.counterpartyPhone);
  if (!id) return { ok: false, reason: "missing" };

  const { data, error } = await db.from(TABLE).select("row_data").eq("id", id).maybeSingle();
  if (error) return { ok: false, reason: "unreadable" };
  const rowData = (data?.row_data as Record<string, unknown> | null) ?? null;
  if (!rowData) return { ok: false, reason: "missing" };
  if (String(rowData.consumedAt ?? "").trim()) return { ok: false, reason: "consumed" };
  const grantedAtMs = Date.parse(String(rowData.grantedAt ?? ""));
  if (!Number.isFinite(grantedAtMs)) return { ok: false, reason: "expired" };
  if (nowMs - grantedAtMs > SMS_REPLY_GRANT_TTL_MS) return { ok: false, reason: "expired" };

  // Conditional on the row still being unconsumed, so two deliveries of the
  // same notification's reply cannot both win the read above and both send.
  const { data: updated, error: updateError } = await db
    .from(TABLE)
    .update({ row_data: { ...rowData, consumedAt: new Date(nowMs).toISOString() } })
    .eq("id", id)
    .is("row_data->>consumedAt", null)
    .select("id");
  if (updateError) return { ok: false, reason: "unreadable" };
  if ((updated ?? []).length === 0) return { ok: false, reason: "consumed" };
  return { ok: true };
}
