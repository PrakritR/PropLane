import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";

/**
 * The `phone_required` switch (`sms_runtime_config.phone_required`): every signed-in account, however it signed in
 * (email, Google, Apple), must hold a VERIFIED phone before it enters a portal, whatever the line mode. It is a separate
 * switch from the shared-line gate (`line_mode = 'shared'`): production turns it on deliberately, after codes are known
 * to reach a phone there. Nothing here changes the shared-mode gate.
 *
 * Fail SAFE: a switch that cannot be read is OFF. A database blip must never send every account to a verification
 * screen, and a provider outage must never lock anyone out, so a code that cannot be sent offers "Skip for now": a
 * signed, short-lived cookie that lets that one sign-in through and is worthless after the next sign-in.
 */

export const PHONE_SKIP_COOKIE = "proplane_phone_skip";
export const PHONE_SEND_FAILED_COOKIE = "proplane_phone_send_failed";
const SEND_FAILED_TTL_SECONDS = 15 * 60;
export const PHONE_SKIP_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A code that could not be sent (the one failure that offers a skip). The message is the generic phone-auth error. */
export class PhoneSendFailedError extends Error {
  readonly sendFailed = true;
}

const phoneRequiredCache = createTtlCache<boolean>(15_000);

/** One row, read on every portal request; a 15 s per-instance snapshot keeps that to a handful of reads a minute. */
export async function loadPhoneRequired(db: SupabaseClient): Promise<boolean> {
  if (!serverSnapshotCacheEnabled()) return readPhoneRequired(db);
  return phoneRequiredCache.get("phone_required", () => readPhoneRequired(db));
}

async function readPhoneRequired(db: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await db.from("sms_runtime_config").select("phone_required").eq("singleton", true).maybeSingle();
    if (error) return false; // includes a missing column (code running before the migration)
    return (data as { phone_required?: unknown } | null)?.phone_required === true;
  } catch {
    return false;
  }
}

function signingKey(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

function sign(kind: "skip" | "failed", userId: string, stamp: string): string | null {
  const key = signingKey();
  if (!key) return null;
  return createHmac("sha256", key).update(`phone-required:${kind}:${userId}:${stamp}`).digest("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The value of the skip cookie for this sign-in: bound to the account AND its last sign-in, so the next sign-in asks again. */
export function phoneSkipValue(userId: string, lastSignInAt: string | null | undefined): string | null {
  return sign("skip", userId, String(lastSignInAt ?? ""));
}

/** The value of the send-failed cookie: proof that a code really could not be sent to this account just now. */
export function phoneSendFailedValue(userId: string, at: number): string | null {
  const mac = sign("failed", userId, String(at));
  return mac ? `${at}.${mac}` : null;
}

export function readPhoneSendFailed(userId: string, cookieValue: string | undefined, now = Date.now()): boolean {
  if (!cookieValue) return false;
  const [at, mac] = cookieValue.split(".");
  const stamp = Number(at);
  if (!mac || !Number.isFinite(stamp) || now - stamp > SEND_FAILED_TTL_SECONDS * 1000 || stamp > now + 60_000) return false;
  const expected = sign("failed", userId, String(stamp));
  return Boolean(expected) && equal(expected!, mac);
}

export const phoneSendFailedCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  secure,
  sameSite: "lax" as const,
  path: "/",
  maxAge: SEND_FAILED_TTL_SECONDS,
});

export const phoneSkipCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  secure,
  sameSite: "lax" as const,
  path: "/",
  maxAge: PHONE_SKIP_TTL_SECONDS,
});

/** Has this account skipped the phone step on its CURRENT sign-in? */
export async function phoneSkipActive(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const jar = await cookies();
    const presented = jar.get(PHONE_SKIP_COOKIE)?.value;
    if (!presented) return false;
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error || !data.user) return false;
    const expected = phoneSkipValue(userId, data.user.last_sign_in_at);
    return Boolean(expected) && equal(expected!, presented);
  } catch {
    return false;
  }
}

/** At most one skip per account per 7 days, and 3 in its lifetime. */
export const PHONE_SKIP_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const PHONE_SKIP_LIFETIME_MAX = 3;

export type PhoneSkipAllowance = { allowed: boolean; reason?: "cooldown" | "lifetime" | "unavailable" };

/**
 * May this account skip the phone step again?
 *
 * The send-failed proof is not enough on its own: for `verify_phone` the person picks the number, so typing an
 * undeliverable one manufactures the proof. The cap turns that into a few delays rather than a standing opt-out.
 * A platform-wide send outage (`sms_runtime_config.phone_send_outage`) lifts the cap, so a real provider failure
 * can never lock everyone out, and an unreadable ledger stays permissive for the same reason.
 */
export async function phoneSkipAllowance(db: SupabaseClient, userId: string, now = new Date()): Promise<PhoneSkipAllowance> {
  try {
    const { data: config } = await db.from("sms_runtime_config").select("phone_send_outage").eq("singleton", true).maybeSingle();
    if ((config as { phone_send_outage?: unknown } | null)?.phone_send_outage === true) return { allowed: true };
  } catch {
    // Unreadable switch: fall through to the cap below.
  }
  const { data, error } = await db
    .from("phone_required_skips")
    .select("created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(PHONE_SKIP_LIFETIME_MAX + 1);
  // A missing table or a failed read must not lock an account out of signing in.
  if (error) return { allowed: true, reason: "unavailable" };
  const rows = (data ?? []) as Array<{ created_at?: string | null }>;
  if (rows.length >= PHONE_SKIP_LIFETIME_MAX) return { allowed: false, reason: "lifetime" };
  const last = Date.parse(String(rows[0]?.created_at ?? ""));
  if (Number.isFinite(last) && now.getTime() - last < PHONE_SKIP_COOLDOWN_MS) return { allowed: false, reason: "cooldown" };
  return { allowed: true };
}

/**
 * Record a granted skip. `false` = it could not be written and the caller must refuse, so the cap cannot be
 * sidestepped by a failing insert. A table that is not there yet (code ahead of the migration) is the one
 * exception: the gate is off in that state anyway, and refusing would lock an account out of its own sign-in.
 */
export async function recordPhoneSkip(db: SupabaseClient, userId: string, now = new Date()): Promise<boolean> {
  const { error } = await db.from("phone_required_skips").insert({ user_id: userId, created_at: now.toISOString() });
  if (!error) return true;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "42P01" || code === "PGRST205" || code === "PGRST204";
}

/** An admin account is exempt from the phone requirement (operators must always be able to sign in and fix things). */
export async function isAdminAccount(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data: roles, error } = await db.from("profile_roles").select("role").eq("user_id", userId).eq("role", "admin").limit(1);
    if (!error && (roles?.length ?? 0) > 0) return true;
    const { data: profile } = await db.from("profiles").select("role").eq("id", userId).maybeSingle();
    return String((profile as { role?: unknown } | null)?.role ?? "").toLowerCase() === "admin";
  } catch {
    // Cannot tell: do not gate an account we might be wrongly locking out.
    return true;
  }
}
