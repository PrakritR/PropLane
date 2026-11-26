import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { readCachedInquiryRows } from "@/lib/tour-resident-link.server";
import type { PhoneEmailEvidence } from "@/lib/sms/phone-email-join";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * One request's worth of evidence.
 *
 * Keyed by owner set + phone. A list request walks up to ten summary pages through `loadPageContext`; a phone
 * already read on an earlier page is never read again, and the application read is filtered in SQL to the
 * phones asked for.
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

/** The platform-wide tour-inquiry blob parsed into phone+email pairings (every owner). One cached read for everyone. */
async function readInquiryEvidence(db: SupabaseClient): Promise<PhoneEmailEvidence[]> {
  const out: PhoneEmailEvidence[] = [];
  for (const row of await readCachedInquiryRows(db)) {
    const phone = normalizeE164(text(row.phone));
    const email = text(row.email).toLowerCase();
    if (!phone || !email.includes("@")) continue;
    const host = text(row.managerUserId);
    if (!host) continue;
    out.push({ ownerUserId: host, phone, email, atMs: Date.parse(text(row.createdAt)) || 0 });
  }
  return out;
}

/**
 * A PostgREST `ilike` pattern that matches ONE phone however it is formatted: every digit of the national
 * number, in order, with anything between them. It over-matches (extra digits around) but never misses
 * "(650) 512-9140" for +16505129140; the caller re-checks every row with `normalizeE164`.
 */
export function phoneDigitsLikePattern(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length < 7 || national.length > 15 || !/^\d+$/.test(national)) return null;
  return `%${national.split("").join("%")}%`;
}

const PHONES_PER_READ = 20;
const EVIDENCE_PAGE = 1000;
const EVIDENCE_MAX_PAGES = 10;

/**
 * Every phone↔email pairing these owners' own records carry for THESE phones. Read-only, best effort. The
 * application read is filtered in SQL to the requested phones (not "the newest 1000 rows, filtered after"),
 * so the ambiguity guard in `emailForPhoneInWorkspace` sees every pairing for a phone, not a truncated window.
 */
async function readOwnerEvidence(db: SupabaseClient, owners: string[], phones: string[]): Promise<PhoneEmailEvidence[]> {
  const ownerSet = new Set(owners);
  const wanted = new Set(phones);
  const out: PhoneEmailEvidence[] = [];
  try {
    const all = await readInquiryEvidence(db);
    for (const item of all) if (ownerSet.has(item.ownerUserId) && wanted.has(item.phone)) out.push(item);
  } catch (error) {
    /* fewer merges, not fewer conversations */
    noteEvidenceReadFailure("tour inquiries", error);
  }
  try {
    const patterns = phones.map(phoneDigitsLikePattern).filter((p): p is string => Boolean(p));
    for (let i = 0; i < patterns.length; i += PHONES_PER_READ) {
      const clauses = patterns
        .slice(i, i + PHONES_PER_READ)
        .flatMap((pattern) => [`row_data->>phone.ilike.${pattern}`, `row_data->>applicantPhone.ilike.${pattern}`]);
      for (let page = 0; page < EVIDENCE_MAX_PAGES; page += 1) {
        // Only the fields the pairing needs: `row_data` holds a whole application and is never worth the egress.
        const { data, error } = await db.from("manager_application_records")
          .select("manager_user_id,resident_email,updated_at,phone:row_data->>phone,applicant_phone:row_data->>applicantPhone")
          .in("manager_user_id", [...ownerSet])
          .not("resident_email", "is", null)
          .or(clauses.join(","))
          .order("updated_at", { ascending: false })
          .order("manager_user_id", { ascending: true })
          .range(page * EVIDENCE_PAGE, (page + 1) * EVIDENCE_PAGE - 1);
        if (error) {
          noteEvidenceReadFailure("applications", error);
          break;
        }
        const rows = (data ?? []) as unknown as {
          manager_user_id: string;
          resident_email: string | null;
          updated_at: string | null;
          phone: string | null;
          applicant_phone: string | null;
        }[];
        for (const record of rows) {
          const phone = normalizeE164(text(record.phone) || text(record.applicant_phone));
          const email = text(record.resident_email).toLowerCase();
          if (!phone || !wanted.has(phone) || !email.includes("@")) continue;
          out.push({ ownerUserId: String(record.manager_user_id), phone, email, atMs: Date.parse(String(record.updated_at ?? "")) || 0 });
        }
        if (rows.length < EVIDENCE_PAGE) break;
      }
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
  const wanted = [...new Set(phones.map((phone) => normalizeE164(phone)).filter((phone): phone is string => Boolean(phone)))].sort();
  const ownerSet = [...new Set(owners)].sort();
  if (wanted.length === 0 || ownerSet.length === 0) return [];
  const ownerKey = ownerSet.join("\u0000");
  // One read per (owner set, phone) per request: phones already read on an earlier page are reused, the rest
  // are read together and each phone's answer is cached on its own.
  const missing = cache ? wanted.filter((phone) => !cache.has(`${ownerKey}\u0001${phone}`)) : wanted;
  if (missing.length > 0) {
    const read = readOwnerEvidence(db, ownerSet, missing);
    if (cache) {
      for (const phone of missing) cache.set(`${ownerKey}\u0001${phone}`, read.then((rows) => rows.filter((row) => row.phone === phone)));
    } else {
      return read;
    }
  }
  const parts = await Promise.all(wanted.map((phone) => cache!.get(`${ownerKey}\u0001${phone}`)!));
  return parts.flat();
}
