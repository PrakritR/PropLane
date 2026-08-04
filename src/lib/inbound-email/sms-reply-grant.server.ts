/**
 * Reply grants for the emailed-SMS-reply path.
 *
 * The `sms+` token is zero-storage and verifies against the reply's `From`
 * header alone, which an attacker can spoof. Since a pass in the message's own
 * `Authentication-Results` proves nothing on its own (`email-authentication.ts`),
 * the token by itself is not enough to send a real text from a manager's
 * business number.
 *
 * A grant narrows the window to what the product actually promises: ONE emailed
 * reply per notification email. Every inbound-text notification adds an
 * allowance; every emailed reply spends one. A replayed, forwarded, or forged
 * reply arriving with nothing left to spend — or against a conversation that
 * never notified the manager — bounces.
 *
 * **The allowance is a COUNTER, not a flag.** Two texts from the same person
 * send two notification emails, and answering both is ordinary behaviour — a
 * single boolean would silently drop the second reply on the leg the product
 * requires to work. It is capped so an unread backlog cannot accumulate into an
 * unbounded licence to text.
 *
 * Stored in `portal_outbound_mail_records` (the same side table the send claim
 * uses) keyed on (manager, counterparty phone), so it needs no migration.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "portal_outbound_mail_records";

/** A grant outlives a weekend of unread mail but not an old forwarded thread. */
export const SMS_REPLY_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ceiling on banked replies. A conversation the manager has left unread for a
 * week must not hand a forger one emailed text per unanswered notification.
 */
export const SMS_REPLY_GRANT_MAX_ALLOWANCE = 5;

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
 * Replies still bankable on this row. Rows written before the allowance counter
 * existed carry a `consumedAt` flag instead, and read as the one reply that
 * flag was worth.
 */
function remainingAllowance(rowData: Record<string, unknown> | null): number {
  if (!rowData) return 0;
  const allowance = rowData.allowance;
  if (typeof allowance === "number" && Number.isFinite(allowance)) {
    return Math.max(0, Math.min(SMS_REPLY_GRANT_MAX_ALLOWANCE, Math.trunc(allowance)));
  }
  return String(rowData.consumedAt ?? "").trim() ? 0 : 1;
}

function hasAllowanceCounter(rowData: Record<string, unknown> | null): boolean {
  return typeof rowData?.allowance === "number" && Number.isFinite(rowData.allowance);
}

async function readGrantRow(
  db: SupabaseClient,
  id: string,
): Promise<{ ok: true; rowData: Record<string, unknown> | null } | { ok: false }> {
  const { data, error } = await db.from(TABLE).select("row_data").eq("id", id).maybeSingle();
  if (error) return { ok: false };
  return { ok: true, rowData: (data?.row_data as Record<string, unknown> | null) ?? null };
}

/**
 * Bank one reply for this conversation. Called after a notification email
 * carrying the reply token actually went out — an allowance with no token in
 * anyone's inbox would only widen the window for a forger.
 *
 * A lost race between two simultaneous notifications banks one instead of two:
 * under-granting is the safe direction, and the next notification restores it.
 */
export async function grantSmsEmailReply(
  db: SupabaseClient,
  args: { managerUserId: string; counterpartyPhone: string; managerEmail: string },
): Promise<boolean> {
  const id = smsReplyGrantRecordId(args.managerUserId, args.counterpartyPhone);
  if (!id) return false;
  const existing = await readGrantRow(db, id);
  if (!existing.ok) return false;
  const grantedAtMs = Date.parse(String(existing.rowData?.grantedAt ?? ""));
  // A stale row's banked replies have already expired — start over rather than
  // reviving them.
  const carried =
    Number.isFinite(grantedAtMs) && Date.now() - grantedAtMs <= SMS_REPLY_GRANT_TTL_MS
      ? remainingAllowance(existing.rowData)
      : 0;

  const { error } = await db.from(TABLE).upsert(
    {
      id,
      recipient_email: args.managerEmail,
      subject: "SMS email-reply grant",
      channel: "sms",
      row_data: {
        ...(existing.rowData ?? {}),
        id,
        kind: "sms_reply_grant",
        managerUserId: args.managerUserId,
        to: args.counterpartyPhone,
        grantedAt: new Date().toISOString(),
        allowance: Math.min(SMS_REPLY_GRANT_MAX_ALLOWANCE, carried + 1),
      },
    },
    { onConflict: "id" },
  );
  return !error;
}

export type SmsReplyGrantConsumption =
  | { ok: true; remaining: number }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "unreadable" };

/**
 * Spend one banked reply. Fails CLOSED on an unreadable row: this is the
 * authorization gate for a spoofable channel, so "we could not check" must
 * refuse (the manager is told to reply in the portal) rather than fall open the
 * way the plan/consent gates deliberately do.
 */
export async function consumeSmsEmailReplyGrant(
  db: SupabaseClient,
  args: { managerUserId: string; counterpartyPhone: string },
  nowMs: number = Date.now(),
): Promise<SmsReplyGrantConsumption> {
  const id = smsReplyGrantRecordId(args.managerUserId, args.counterpartyPhone);
  if (!id) return { ok: false, reason: "missing" };

  const read = await readGrantRow(db, id);
  if (!read.ok) return { ok: false, reason: "unreadable" };
  const rowData = read.rowData;
  if (!rowData) return { ok: false, reason: "missing" };

  const grantedAtMs = Date.parse(String(rowData.grantedAt ?? ""));
  if (!Number.isFinite(grantedAtMs)) return { ok: false, reason: "expired" };
  if (nowMs - grantedAtMs > SMS_REPLY_GRANT_TTL_MS) return { ok: false, reason: "expired" };

  const remaining = remainingAllowance(rowData);
  if (remaining <= 0) return { ok: false, reason: "consumed" };

  // Compare-and-set on the value just read, so two deliveries of the same
  // reply cannot both pass the check above and both spend the same allowance.
  const write = db
    .from(TABLE)
    .update({
      row_data: {
        ...rowData,
        allowance: remaining - 1,
        lastConsumedAt: new Date(nowMs).toISOString(),
      },
    })
    .eq("id", id);
  const guarded = hasAllowanceCounter(rowData)
    ? write.eq("row_data->>allowance", String(remaining))
    : write.is("row_data->>consumedAt", null);
  const { data: updated, error: updateError } = await guarded.select("id");
  if (updateError) return { ok: false, reason: "unreadable" };
  if ((updated ?? []).length === 0) return { ok: false, reason: "consumed" };
  return { ok: true, remaining: remaining - 1 };
}
