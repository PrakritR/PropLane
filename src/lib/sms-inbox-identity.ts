import { conversationPhoneRef } from "@/lib/sms-conversation-identity";

/** Only an explicit phone label is identity; never mine message text or names. */
export function smsNoticePhone(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!/^[+\d().\s-]+$/.test(value)) return "";
  const phone = conversationPhoneRef(value);
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : "";
}

export function smsNoticeIdentity(row: {
  id: string; from: string; threadType?: string | null; thread_type?: string | null;
  ownerUserId?: string; smsNoticePhone?: string;
}): string | undefined {
  const type = row.threadType ?? row.thread_type;
  if (!row.ownerUserId || (!['claw_resident_sms', 'claw_leasing_sms', 'sms_relay'].includes(type ?? '')
    && !/^(claw_resident_|claw_lease_|sms_relay_|sms_notice_)/.test(row.id))) return;
  const phone = smsNoticePhone(row.smsNoticePhone || row.from);
  return phone ? `sms-notice:${row.ownerUserId}:${phone}` : undefined;
}
