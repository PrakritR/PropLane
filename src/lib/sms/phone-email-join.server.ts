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
 * One request's worth of evidence, keyed by the owner set it was read for.
 *
 * The reads behind it are per-OWNER, not per-phone (a phone lives inside `row_data`, where no index can
 * reach it), so they are made once and filtered in memory for every later page. A list request walks up to
 * ten summary pages through `loadPageContext`; without this the same tour-inquiry blob and the same
 * application rows would come down the wire ten times.
 */
export type PhoneEmailEvidenceCache = Map<string, Promise<PhoneEmailEvidence[]>>;

export function createPhoneEmailEvidenceCache(): PhoneEmailEvidenceCache {
  return new Map();
}

/**
 * A read that answers with an error yields no evidence at all, which looks exactly like a workspace that
 * never paired a phone with an email — so the join would be dead in production with nothing to see. PostgREST
 * reports a bad filter, a missing column or a withheld grant in `error` rather than by throwing, so both are
 * logged here; the caller still carries on with whatever evidence it did get.
 */
function noteEvidenceReadFailure(label: string, error: unknown): void {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? "").slice(0, 300);
  console.warn(`[inbox] phone/email evidence read failed: ${label}`, code || "UNKNOWN", message);
}

/** Every phone↔email pairing these owners' own records carry. Read-only, best effort. */
async function readOwnerEvidence(db: SupabaseClient, owners: string[]): Promise<PhoneEmailEvidence[]> {
  const ownerSet = new Set(owners);
  const out: PhoneEmailEvidence[] = [];
  try {
    const { data, error } = await db.from("portal_schedule_records").select("row_data").eq("id", INQUIRIES_RECORD_ID).maybeSingle();
    if (error) noteEvidenceReadFailure("tour inquiries", error);
    for (const row of inquiryRowsFromRecord(data?.row_data)) {
      const phone = normalizeE164(text(row.phone));
      const email = text(row.email).toLowerCase();
      if (!phone || !email.includes("@")) continue;
      const host = text(row.managerUserId);
      if (!host || !ownerSet.has(host)) continue;
      const atMs = Date.parse(text(row.createdAt)) || 0;
      out.push({ ownerUserId: host, phone, email, atMs });
    }
  } catch (error) {
    /* fewer merges, not fewer conversations */
    noteEvidenceReadFailure("tour inquiries", error);
  }
  try {
    // Only the three fields the pairing needs: `row_data` holds a whole application and is never worth
    // the egress here. The `or` keeps rows that name no phone at all out of the response entirely.
    const { data, error } = await db.from("manager_application_records")
      .select("manager_user_id,resident_email,updated_at,phone:row_data->>phone,applicant_phone:row_data->>applicantPhone")
      .in("manager_user_id", [...ownerSet])
      .not("resident_email", "is", null)
      .or("row_data->>phone.not.is.null,row_data->>applicantPhone.not.is.null")
      .order("updated_at", { ascending: false })
      .limit(1000);
    if (error) noteEvidenceReadFailure("applications", error);
    for (const record of (data ?? []) as unknown as {
      manager_user_id: string;
      resident_email: string | null;
      updated_at: string | null;
      phone: string | null;
      applicant_phone: string | null;
    }[]) {
      const phone = normalizeE164(text(record.phone) || text(record.applicant_phone));
      const email = text(record.resident_email).toLowerCase();
      if (!phone || !email.includes("@")) continue;
      out.push({ ownerUserId: String(record.manager_user_id), phone, email, atMs: Date.parse(String(record.updated_at ?? "")) || 0 });
    }
  } catch (error) {
    /* as above */
    noteEvidenceReadFailure("applications", error);
  }
  return out;
}

/**
 * Tour requests and applications that name BOTH a phone and an email, per workspace owner. Read-only, best effort:
 * any failed read yields less evidence (fewer merges), never a hidden conversation. Pass `cache` (one per request)
 * so a paged read makes the owner reads once instead of once per page.
 */
export async function loadPhoneEmailEvidence(
  db: SupabaseClient,
  owners: string[],
  phones: string[],
  cache?: PhoneEmailEvidenceCache,
): Promise<PhoneEmailEvidence[]> {
  const wanted = new Set(phones.map((phone) => normalizeE164(phone)).filter((phone): phone is string => Boolean(phone)));
  const ownerSet = [...new Set(owners)].sort();
  if (wanted.size === 0 || ownerSet.length === 0) return [];
  const key = ownerSet.join("\u0000");
  let pending = cache?.get(key);
  if (!pending) {
    pending = readOwnerEvidence(db, ownerSet);
    cache?.set(key, pending);
  }
  return (await pending).filter((item) => wanted.has(item.phone));
}
