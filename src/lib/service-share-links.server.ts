import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rateLimit } from "@/lib/rate-limit";
import { resolveTestWorkspaceClassification, lookupRecordTestWorkspaceId } from "@/lib/test-workspaces/index.server";

/**
 * Hashed-token links to ONE service (vendor-work-share-1006), texted to a vendor's phone and
 * resolved at the public `/s/<token>` page. Modeled on `portal-record-share-links.server.ts` with
 * two differences that matter:
 *
 *  - the DATABASE never holds the token, only its SHA-256 (`token_hash`): a leaked table or backup
 *    hands out no working link, and a link cannot be re-derived from a row;
 *  - a link is bound to the phone it was texted to (`recipient_phone`), which becomes the phone on
 *    the vendor's roster row when they sign up from it.
 *
 * A link grants the PUBLIC view of the service (`publicServiceProjection`) and the right to start
 * sign-up. It never creates an account, an offer or a bid by itself: redeeming needs a signed-in
 * vendor (`redeemServiceShareLink` in `service-work-board.server.ts`).
 */

export const SERVICE_SHARE_LINK_DAYS = 14;
/** Texts one manager may send per rolling day, across all services. */
export const SERVICE_SHARE_SMS_PER_MANAGER_PER_DAY = 25;
/** Public resolves (page loads) per IP per minute, and per token per minute. */
export const SERVICE_SHARE_RESOLVE_PER_IP_PER_MIN = 30;
export const SERVICE_SHARE_RESOLVE_PER_TOKEN_PER_MIN = 60;
/** A manager may keep this many live links on one service. */
export const SERVICE_SHARE_MAX_LIVE_LINKS_PER_SERVICE = 20;

export type ServiceShareLinkRow = {
  id: string;
  workOrderId: string;
  managerUserId: string;
  recipientPhone: string;
  recipientName: string | null;
  sharePhotos: boolean;
  expiresAt: string;
  revokedAt: string | null;
  accessCount: number;
  redeemedByUserId: string | null;
};

const COLUMNS =
  "id, work_order_id, manager_user_id, recipient_phone, recipient_name, share_photos, expires_at, revoked_at, access_count, redeemed_by_user_id, created_by";

/** SHA-256 hex of the presented token. The one place a token becomes a database key. */
export function hashServiceShareToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function generateServiceShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export function buildServiceShareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/s/${encodeURIComponent(token)}`;
}

function mapRow(raw: Record<string, unknown>): ServiceShareLinkRow {
  return {
    id: String(raw.id),
    workOrderId: String(raw.work_order_id),
    managerUserId: String(raw.manager_user_id),
    recipientPhone: String(raw.recipient_phone ?? ""),
    recipientName: raw.recipient_name ? String(raw.recipient_name) : null,
    sharePhotos: raw.share_photos === true,
    expiresAt: String(raw.expires_at),
    revokedAt: raw.revoked_at ? String(raw.revoked_at) : null,
    accessCount: Number(raw.access_count) || 0,
    redeemedByUserId: raw.redeemed_by_user_id ? String(raw.redeemed_by_user_id) : null,
  };
}

/** Per-manager daily text cap. Counted BEFORE the text goes out; a refused cap sends nothing. */
export async function consumeServiceShareSmsAllowance(managerUserId: string): Promise<boolean> {
  const result = await rateLimit(
    `service-share-sms:${managerUserId}`,
    SERVICE_SHARE_SMS_PER_MANAGER_PER_DAY,
    24 * 60 * 60 * 1000,
  );
  return result.ok;
}

/** Public-page throttles. Per IP stops a crawler walking tokens; per token stops one link being hammered. */
export async function allowServiceShareResolve(input: { ip: string; tokenHash: string }): Promise<boolean> {
  const [byIp, byToken] = await Promise.all([
    rateLimit(`service-share-resolve-ip:${input.ip}`, SERVICE_SHARE_RESOLVE_PER_IP_PER_MIN, 60_000),
    rateLimit(`service-share-resolve-token:${input.tokenHash.slice(0, 32)}`, SERVICE_SHARE_RESOLVE_PER_TOKEN_PER_MIN, 60_000),
  ]);
  return byIp.ok && byToken.ok;
}

export async function createServiceShareLink(
  db: SupabaseClient,
  input: {
    workOrderId: string;
    managerUserId: string;
    createdBy: string;
    recipientPhone: string;
    recipientName?: string | null;
    sharePhotos: boolean;
    now?: Date;
  },
): Promise<{ link: ServiceShareLinkRow; token: string }> {
  const managerUserId = input.managerUserId.trim();
  const createdBy = input.createdBy.trim();
  const workOrderId = input.workOrderId.trim();
  if (!managerUserId || !createdBy || !workOrderId || !input.recipientPhone.trim()) {
    throw new Error("Service links need a service, an owner and a phone.");
  }
  // A public bearer link must never bridge into a private test namespace.
  const [owner, creator, recordWorkspaceId] = await Promise.all([
    resolveTestWorkspaceClassification(managerUserId, db),
    resolveTestWorkspaceClassification(createdBy, db),
    lookupRecordTestWorkspaceId("portal_work_order_records", workOrderId, db),
  ]);
  if (owner.kind === "classified" || creator.kind === "classified" || recordWorkspaceId) {
    throw new Error("Public service links are unavailable for this account.");
  }

  const now = input.now ?? new Date();
  const { count } = await db
    .from("service_share_links")
    .select("id", { count: "exact", head: true })
    .eq("work_order_id", workOrderId)
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString());
  if ((count ?? 0) >= SERVICE_SHARE_MAX_LIVE_LINKS_PER_SERVICE) {
    throw new Error("This service already has the most live links it can have. Revoke one first.");
  }

  const token = generateServiceShareToken();
  const expiresAt = new Date(now.getTime() + SERVICE_SHARE_LINK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("service_share_links")
    .insert({
      work_order_id: workOrderId,
      manager_user_id: managerUserId,
      created_by: createdBy,
      token_hash: hashServiceShareToken(token),
      recipient_phone: input.recipientPhone.trim(),
      recipient_name: input.recipientName?.trim().slice(0, 120) || null,
      share_photos: input.sharePhotos,
      expires_at: expiresAt,
    })
    .select(COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return { link: mapRow(data as Record<string, unknown>), token };
}

/** Stamp the moment the text actually went out (a link minted but never delivered stays NULL). */
export async function markServiceShareLinkTexted(db: SupabaseClient, linkId: string): Promise<void> {
  await db.from("service_share_links").update({ texted_at: new Date().toISOString() }).eq("id", linkId);
}

export type ResolvedServiceShareLink = { link: ServiceShareLinkRow };

/**
 * Resolve a presented token (no auth). Null for an unknown, revoked or expired token — the caller
 * must not say which. `count` is false for a read that must not bump the access count (a redeem).
 */
export async function resolveServiceShareToken(
  db: SupabaseClient,
  token: string,
  opts: { count?: boolean; now?: Date } = {},
): Promise<ResolvedServiceShareLink | null> {
  const trimmed = token.trim();
  // Tokens are 32 base64url chars; refuse anything else before it reaches the database.
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(trimmed)) return null;
  const { data: row, error } = await db
    .from("service_share_links")
    .select(COLUMNS)
    .eq("token_hash", hashServiceShareToken(trimmed))
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !row) return null;
  const now = opts.now ?? new Date();
  if (new Date(String(row.expires_at)).getTime() <= now.getTime()) return null;

  const [owner, recordWorkspaceId] = await Promise.all([
    resolveTestWorkspaceClassification(String(row.manager_user_id ?? ""), db),
    lookupRecordTestWorkspaceId("portal_work_order_records", String(row.work_order_id ?? ""), db),
  ]);
  if (owner.kind === "classified" || recordWorkspaceId) return null;

  if (opts.count !== false) {
    await db
      .from("service_share_links")
      .update({ access_count: (Number(row.access_count) || 0) + 1, last_accessed_at: now.toISOString() })
      .eq("id", row.id);
  }
  return { link: mapRow(row as Record<string, unknown>) };
}

/** Revoke every live link on one service (manager auth is the caller's job). */
export async function revokeServiceShareLinks(
  db: SupabaseClient,
  input: { workOrderId: string; managerUserId: string },
): Promise<number> {
  const { data, error } = await db
    .from("service_share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("work_order_id", input.workOrderId.trim())
    .eq("manager_user_id", input.managerUserId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}
