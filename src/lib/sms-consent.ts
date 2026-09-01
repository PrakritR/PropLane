import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * SMS consent (opt-in/opt-out) ledger. Stored keyed by a normalized digit
 * string so the same US number matches regardless of how a webhook or profile
 * formats it (`+15551234567`, `15551234567`, `(555) 123-4567`, …).
 *
 * All reads/writes use a service-role client — the sms_consent table is
 * service-role-only (RLS enabled, no policies).
 */

/**
 * Canonicalize a US phone to a bare 10-digit string so the same number matches
 * regardless of source formatting. Twilio delivers `From` in E.164
 * (`+15551234567` → 11 digits), while `profiles.phone` is stored un-normalized
 * for residents/vendors (`(555) 123-4567`, `5551234567`). Both must reduce to
 * the SAME key or an opted-out number is silently texted (fail-open). Strips the
 * leading US country code so `+15551234567`, `15551234567`, and `5551234567` all
 * become `5551234567`.
 */
export function normalizeConsentPhone(phone: string): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Values safe for `profiles.phone` lookups (Postgres numeric — no punctuation). */
function profilePhoneDbLookupValues(phone: string): string[] {
  const raw = String(phone ?? "").trim();
  const key = normalizeConsentPhone(raw);
  const values = key.length === 10 ? [`+1${key}`, key, `1${key}`, raw] : [raw, key];
  return [...new Set(values.filter((value) => /^\+?\d+$/.test(value)))];
}

/**
 * Common stored formats for one US number so consent reads can match
 * `profiles.phone` regardless of how the inbound webhook or profile row
 * formats the digits. Only digit/E.164 forms are emitted: the column is
 * numeric in Postgres, and punctuation variants make the whole `.in()`
 * query fail with `invalid input syntax for type numeric`.
 */
export function profilePhoneVariants(phone: string): string[] {
  return profilePhoneDbLookupValues(phone);
}

/** Opted out iff opted_out_at is set and no opt-in is at least as recent. */
export function optedOutFromTimestamps(
  optedInRaw: unknown,
  optedOutRaw: unknown,
): boolean {
  const optedOutAt = optedOutRaw ? Date.parse(String(optedOutRaw)) : null;
  if (optedOutAt == null || Number.isNaN(optedOutAt)) return false;
  const optedInAt = optedInRaw ? Date.parse(String(optedInRaw)) : null;
  if (optedInAt != null && !Number.isNaN(optedInAt) && optedInAt >= optedOutAt) return false;
  return true;
}

export type SmsSuppressionState =
  | { ok: true; optedOut: boolean }
  | { ok: false; error: string };

/**
 * Fail-closed suppression read for the durable dispatcher. Unlike the legacy
 * boolean helper, this preserves infrastructure errors so an outage cannot be
 * mistaken for permission to send.
 */
export async function readSmsSuppressionState(
  db: SupabaseClient,
  phone: string,
  opts?: { userId?: string | null },
): Promise<SmsSuppressionState> {
  const key = normalizeConsentPhone(phone);
  const userId = opts?.userId ?? null;
  if (!key && !userId) return { ok: false, error: "invalid_recipient_phone" };

  const optIns: number[] = [];
  const optOuts: number[] = [];
  const push = (arr: number[], raw: unknown) => {
    const value = raw ? Date.parse(String(raw)) : NaN;
    if (!Number.isNaN(value)) arr.push(value);
  };

  if (key) {
    const { data: ledger, error: ledgerError } = await db
      .from("sms_consent")
      .select("opted_in_at, opted_out_at")
      .eq("phone", key)
      .maybeSingle();
    if (ledgerError) return { ok: false, error: "suppression_ledger_unreadable" };
    push(optIns, ledger?.opted_in_at);
    push(optOuts, ledger?.opted_out_at);

    const { data: profiles, error: profileError } = await db
      .from("profiles")
      .select("sms_opt_out_at, sms_consent_at")
      .in("phone", profilePhoneVariants(phone));
    if (profileError) return { ok: false, error: "profile_suppression_unreadable" };
    for (const profile of profiles ?? []) {
      push(optIns, profile.sms_consent_at);
      push(optOuts, profile.sms_opt_out_at);
    }
  }

  if (userId) {
    const { data: own, error: ownError } = await db
      .from("profiles")
      .select("sms_opt_out_at, sms_consent_at")
      .eq("id", userId)
      .maybeSingle();
    if (ownError) return { ok: false, error: "user_suppression_unreadable" };
    push(optIns, own?.sms_consent_at);
    push(optOuts, own?.sms_opt_out_at);
  }

  if (optOuts.length === 0) return { ok: true, optedOut: false };
  const latestOut = Math.max(...optOuts);
  const latestIn = optIns.length > 0 ? Math.max(...optIns) : null;
  return { ok: true, optedOut: latestIn == null || latestIn < latestOut };
}

export type ScopedSmsConsent = {
  managerUserId: string;
  purpose: string;
  sendClass: "transactional" | "automated";
  conversationKey?: string | null;
  messagingServiceSid?: string | null;
};

export type ScopedSmsConsentState =
  | { ok: true; state: "none" | "granted" | "revoked" }
  | { ok: false; error: string };

/** Latest matching scoped evidence wins; callers can distinguish no evidence from a revoke. */
export async function readScopedSmsConsentState(
  db: SupabaseClient,
  phone: string,
  scope: ScopedSmsConsent,
): Promise<ScopedSmsConsentState> {
  const key = normalizeConsentPhone(phone);
  if (!key || !scope.managerUserId.trim() || !scope.purpose.trim()) {
    return { ok: false, error: "invalid_consent_scope" };
  }
  let query = db
    .from("sms_consent_events")
    .select("event_type")
    .eq("recipient_phone_key", key)
    .eq("manager_user_id", scope.managerUserId)
    .eq("purpose", scope.purpose)
    .eq("send_class", scope.sendClass)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  if (scope.conversationKey) query = query.eq("conversation_key", scope.conversationKey);
  if (scope.messagingServiceSid) query = query.eq("messaging_service_sid", scope.messagingServiceSid);
  const { data, error } = await query;
  if (error) return { ok: false, error: "scoped_consent_unreadable" };
  const eventType = data?.[0]?.event_type;
  return { ok: true, state: eventType === "granted" || eventType === "revoked" ? eventType : "none" };
}

/** Latest matching scoped evidence wins; a revoke therefore cannot be bypassed. */
export async function hasScopedSmsConsent(
  db: SupabaseClient,
  phone: string,
  scope: ScopedSmsConsent,
): Promise<{ ok: true; granted: boolean } | { ok: false; error: string }> {
  const result = await readScopedSmsConsentState(db, phone, scope);
  return result.ok ? { ok: true, granted: result.state === "granted" } : result;
}

export async function recordScopedSmsConsent(
  db: SupabaseClient,
  phone: string,
  scope: ScopedSmsConsent & {
    eventType: "granted" | "revoked";
    source: string;
    wordingVersion?: string | null;
    evidence?: Record<string, unknown>;
    occurredAt?: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = normalizeConsentPhone(phone);
  if (!key) return { ok: false, error: "invalid_recipient_phone" };
  const occurredAt = scope.occurredAt?.trim();
  if (occurredAt && Number.isNaN(Date.parse(occurredAt))) {
    return { ok: false, error: "invalid_consent_timestamp" };
  }
  const { error } = await db.from("sms_consent_events").insert({
    recipient_phone_key: key,
    manager_user_id: scope.managerUserId,
    messaging_service_sid: scope.messagingServiceSid ?? null,
    purpose: scope.purpose,
    send_class: scope.sendClass,
    conversation_key: scope.conversationKey ?? null,
    event_type: scope.eventType,
    source: scope.source,
    wording_version: scope.wordingVersion ?? null,
    evidence: scope.evidence ?? {},
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
  });
  return error ? { ok: false, error: "scoped_consent_write_failed" } : { ok: true };
}

/** Restore only previously known scopes after a carrier-valid START keyword. */
export async function restoreScopedSmsConsentAfterStart(
  db: SupabaseClient,
  phone: string,
  managerUserId: string,
  messagingServiceSid: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = normalizeConsentPhone(phone);
  if (!key) return { ok: false, error: "invalid_recipient_phone" };
  const { data, error } = await db
    .from("sms_consent_events")
    .select("purpose, send_class, conversation_key, event_type, wording_version")
    .eq("recipient_phone_key", key)
    .eq("manager_user_id", managerUserId)
    .eq("messaging_service_sid", messagingServiceSid)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return { ok: false, error: "scoped_consent_unreadable" };
  const seen = new Set<string>();
  const restores: Record<string, unknown>[] = [];
  for (const row of data ?? []) {
    const scopeKey = [row.purpose, row.send_class, row.conversation_key ?? ""].join("|");
    if (seen.has(scopeKey)) continue;
    seen.add(scopeKey);
    if (row.event_type !== "revoked") continue;
    restores.push({
      recipient_phone_key: key,
      manager_user_id: managerUserId,
      messaging_service_sid: messagingServiceSid,
      purpose: row.purpose,
      send_class: row.send_class,
      conversation_key: row.conversation_key,
      event_type: "granted",
      source: "twilio_start",
      wording_version: row.wording_version,
      evidence: {},
    });
  }
  if (restores.length === 0) return { ok: true };
  const { error: restoreError } = await db.from("sms_consent_events").insert(restores);
  return restoreError ? { ok: false, error: "scoped_consent_write_failed" } : { ok: true };
}

/**
 * True when the number is opted out — the single unified read path. STOP and
 * START are recorded in two places by different webhooks:
 *   1. `sms_consent` ledger (phone-keyed) — the manager work-line webhook.
 *   2. `profiles.sms_opt_out_at` / `sms_consent_at` (user-keyed) — the
 *      vendor-agent webhook and in-portal consent.
 * Every send funnels through this choke point. Supersede is computed GLOBALLY
 * across both stores: the latest opt-in anywhere beats an older opt-out
 * anywhere, so a STOP on one line followed by a START on the other re-enables
 * the number instead of dead-ending. When `opts.userId` is given, that
 * profile row's timestamps join the same comparison even if its stored phone
 * is empty or unmatchable — a legacy user-keyed STOP keeps blocking until a
 * later opt-in on any store supersedes it. A number we've never seen is NOT
 * opted out; a secondary-store error drops only that store's timestamps, so
 * the ledger alone still governs.
 */
export async function isPhoneOptedOut(
  db: SupabaseClient,
  phone: string,
  opts?: { userId?: string | null },
): Promise<boolean> {
  const key = normalizeConsentPhone(phone);
  const userId = opts?.userId ?? null;
  if (!key && !userId) return false;

  const optIns: number[] = [];
  const optOuts: number[] = [];
  const push = (arr: number[], raw: unknown) => {
    const t = raw ? Date.parse(String(raw)) : NaN;
    if (!Number.isNaN(t)) arr.push(t);
  };

  if (key) {
    // 1) Canonical phone-keyed ledger.
    const { data: ledger } = await db
      .from("sms_consent")
      .select("opted_in_at, opted_out_at")
      .eq("phone", key)
      .maybeSingle();
    push(optIns, ledger?.opted_in_at);
    push(optOuts, ledger?.opted_out_at);

    // 2) Bridge the vendor store: any profile whose phone matches this number
    // contributes its opt-out/consent timestamps to the global comparison.
    try {
      const { data: profiles } = await db
        .from("profiles")
        .select("sms_opt_out_at, sms_consent_at")
        .in("phone", profilePhoneVariants(phone));
      for (const p of profiles ?? []) {
        push(optIns, p.sms_consent_at);
        push(optOuts, p.sms_opt_out_at);
      }
    } catch {
      /* fail open on the secondary store — the timestamps gathered above still govern */
    }
  }

  // 3) Explicit user-keyed row (e.g. the vendor bound to a session), covering
  // opt-outs recorded against a profile whose phone column doesn't match.
  if (userId) {
    try {
      const { data: own } = await db
        .from("profiles")
        .select("sms_opt_out_at, sms_consent_at")
        .eq("id", userId)
        .maybeSingle();
      push(optIns, own?.sms_consent_at);
      push(optOuts, own?.sms_opt_out_at);
    } catch {
      /* fail open on the secondary store — the timestamps gathered above still govern */
    }
  }

  if (optOuts.length === 0) return false;
  const latestOut = Math.max(...optOuts);
  const latestIn = optIns.length > 0 ? Math.max(...optIns) : null;
  return latestIn == null || latestIn < latestOut;
}

/** Record that a number opted OUT (STOP/UNSUBSCRIBE/…). Idempotent upsert. */
export async function recordOptOut(
  db: SupabaseClient,
  phone: string,
  userId?: string | null,
): Promise<void> {
  const key = normalizeConsentPhone(phone);
  if (!key) return;
  const now = new Date().toISOString();
  await db
    .from("sms_consent")
    .upsert(
      {
        phone: key,
        ...(userId ? { user_id: userId } : {}),
        opted_out_at: now,
        updated_at: now,
      },
      { onConflict: "phone" },
    )
    .then(() => undefined, () => undefined);
}

/** Record that a number opted IN (START/YES/UNSTOP or explicit consent). */
export async function recordOptIn(
  db: SupabaseClient,
  phone: string,
  userId?: string | null,
  source?: string | null,
): Promise<void> {
  const key = normalizeConsentPhone(phone);
  if (!key) return;
  const now = new Date().toISOString();
  await db
    .from("sms_consent")
    .upsert(
      {
        phone: key,
        ...(userId ? { user_id: userId } : {}),
        opted_in_at: now,
        ...(source ? { consent_source: source } : {}),
        updated_at: now,
      },
      { onConflict: "phone" },
    )
    .then(() => undefined, () => undefined);
}
