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
