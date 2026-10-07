import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { featureSigningSecret } from "@/lib/feature-signing-secret.server";

/**
 * The vendor's private iCal "Calendar link". The token is NOT stored: it is
 * `base64url(HMAC-SHA256(secret, "vendor-calendar-feed:<vendorUserId>:<version>"))`,
 * so a leaked table or backup cannot mint a working link. The only stored state is
 * a per-vendor `version`; "Reset link" bumps it, which makes every earlier token
 * recompute to something else and 404. `revoked_at` switches the feed off outright.
 *
 * Same secret convention as `vendor-work-number-claim-token.server.ts`: the service
 * role key every real deployment already requires (`featureSigningSecret`,
 * which refuses to sign at all when it is missing rather than falling back to a
 * literal anyone could read out of this file).
 */
export type VendorCalendarFeedState = { version: number; revoked: boolean };

export const VENDOR_CALENDAR_FEED_TABLE = "vendor_calendar_feeds";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isVendorCalendarFeedVendorId(value: string): boolean {
  return UUID_RE.test(value);
}

function feedSecret(): string {
  return featureSigningSecret("vendor-calendar-feed");
}

export function vendorCalendarFeedToken(vendorUserId: string, version: number): string {
  return createHmac("sha256", feedSecret())
    .update(`vendor-calendar-feed:${vendorUserId}:${version}`)
    .digest("base64url");
}

export function vendorCalendarFeedUrl(origin: string, vendorUserId: string, version: number): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/api/calendar/vendor/${vendorUserId}/${vendorCalendarFeedToken(vendorUserId, version)}.ics`;
}

/** True when the error means the migration has not been applied yet. */
export function isMissingRelationError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes(VENDOR_CALENDAR_FEED_TABLE) &&
    (message.includes("does not exist") || message.includes("schema cache") || message.includes("relation"))
  );
}

/** Absent row, or a table not yet migrated, reads as version 1 and not revoked. */
export async function loadVendorCalendarFeedState(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<VendorCalendarFeedState> {
  const { data, error } = await db
    .from(VENDOR_CALENDAR_FEED_TABLE)
    .select("version, revoked_at")
    .eq("vendor_user_id", vendorUserId)
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return { version: 1, revoked: false };
    throw new Error(error.message);
  }
  if (!data) return { version: 1, revoked: false };
  const version = Number((data as { version?: unknown }).version);
  return {
    version: Number.isInteger(version) && version >= 1 ? version : 1,
    revoked: Boolean((data as { revoked_at?: unknown }).revoked_at),
  };
}

/** Constant-time check of a presented token (with or without a trailing `.ics`) against the vendor's current version. */
export async function verifyVendorCalendarFeedToken(
  db: SupabaseClient,
  vendorUserId: string,
  presented: string,
): Promise<boolean> {
  if (!isVendorCalendarFeedVendorId(vendorUserId)) return false;
  const state = await loadVendorCalendarFeedState(db, vendorUserId);
  if (state.revoked) return false;
  const token = presented.replace(/\.ics$/i, "");
  const wanted = Buffer.from(vendorCalendarFeedToken(vendorUserId, state.version), "utf8");
  const provided = Buffer.from(token, "utf8");
  if (provided.length !== wanted.length) return false;
  return timingSafeEqual(provided, wanted);
}

/** Bumps the version (and clears any revoke) so the previous URL stops working. A failure is returned, never thrown. */
export async function resetVendorCalendarFeed(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<{ ok: true; version: number } | { ok: false }> {
  try {
    const current = await loadVendorCalendarFeedState(db, vendorUserId);
    const version = current.version + 1;
    const { error } = await db.from(VENDOR_CALENDAR_FEED_TABLE).upsert(
      {
        vendor_user_id: vendorUserId,
        version,
        revoked_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "vendor_user_id" },
    );
    if (error) return { ok: false };
    return { ok: true, version };
  } catch {
    return { ok: false };
  }
}
