import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { inquiryRowsFromRecord } from "@/lib/tour-resident-link.server";
import { INQUIRIES_RECORD_ID } from "@/lib/tour-inquiry.server";
import type { PhoneEmailEvidence } from "@/lib/sms/phone-email-join";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Tour requests and applications that name BOTH a phone and an email, per workspace owner. Read-only, best effort:
 * any failed read yields less evidence (fewer merges), never a hidden conversation.
 */
export async function loadPhoneEmailEvidence(
  db: SupabaseClient,
  owners: string[],
  phones: string[],
): Promise<PhoneEmailEvidence[]> {
  const wanted = new Set(phones.map((phone) => normalizeE164(phone)).filter((phone): phone is string => Boolean(phone)));
  const ownerSet = new Set(owners);
  if (wanted.size === 0 || ownerSet.size === 0) return [];
  const out: PhoneEmailEvidence[] = [];
  try {
    const { data } = await db.from("portal_schedule_records").select("row_data").eq("id", INQUIRIES_RECORD_ID).maybeSingle();
    for (const row of inquiryRowsFromRecord(data?.row_data)) {
      const phone = normalizeE164(text(row.phone));
      const email = text(row.email).toLowerCase();
      if (!phone || !wanted.has(phone) || !email.includes("@")) continue;
      const host = text(row.managerUserId);
      if (!host || !ownerSet.has(host)) continue;
      const atMs = Date.parse(text(row.createdAt)) || 0;
      out.push({ ownerUserId: host, phone, email, atMs });
    }
  } catch {
    /* fewer merges, not fewer conversations */
  }
  try {
    const { data } = await db.from("manager_application_records")
      .select("manager_user_id,resident_email,row_data,updated_at")
      .in("manager_user_id", [...ownerSet]).order("updated_at", { ascending: false }).limit(1000);
    for (const record of data ?? []) {
      const row = (record.row_data ?? {}) as Record<string, unknown>;
      const phone = normalizeE164(text(row.phone) || text(row.applicantPhone));
      const email = text(record.resident_email).toLowerCase();
      if (!phone || !wanted.has(phone) || !email.includes("@")) continue;
      out.push({ ownerUserId: String(record.manager_user_id), phone, email, atMs: Date.parse(String(record.updated_at ?? "")) || 0 });
    }
  } catch {
    /* as above */
  }
  return out;
}
