import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import {
  PHONE_BOUND_LINK_POLICY,
  SHARED_LINE_OTP_RULES,
  type PhoneBoundLinkPurpose,
} from "@/lib/one-number/contracts";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

/**
 * Phone-bound signed links: the one link service for every texted or public link (spec "Links
 * tied to the phone number"). A link is a random 32-byte token whose SHA-256 is the only thing
 * stored (`phone_bound_links.token_hash`): a leaked table or backup hands out no working link and
 * a link cannot be re-derived from a row. The URL (`/l/<token>`) carries no PII.
 *
 * Every refusal reads the same to the holder of a token: an unknown, expired, revoked or used link
 * all resolve to `null`, and the page shows one "This link has expired" view. Nothing here says
 * which, so a token cannot be used to probe for a link's existence or its target.
 */

export const PHONE_BOUND_PURPOSES = Object.keys(PHONE_BOUND_LINK_POLICY) as PhoneBoundLinkPurpose[];

/** 32 random bytes, base64url. The pattern also admits the shorter tokens other services mint. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
/** Longest target id stored; ids here are record ids, never free text. */
const MAX_TARGET_LENGTH = 200;
/** Links one phone may be sent per hour. A cap on spam, not on real use. */
export const PHONE_BOUND_MINTS_PER_PHONE_PER_HOUR = 20;
/** Purposes that move money or identity: the verified page session is the short one. */
const MONEY_PURPOSES: ReadonlySet<PhoneBoundLinkPurpose> = new Set<PhoneBoundLinkPurpose>(["rent", "payouts"]);

export type PhoneBoundLink = {
  id: string;
  phoneKey: string;
  workspaceId: string | null;
  purpose: PhoneBoundLinkPurpose;
  targetType: string;
  targetId: string;
  requiresOtp: boolean;
  /** Null = until the target closes (a job). */
  expiresAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  openCount: number;
  createdBy: string | null;
};

const COLUMNS =
  "id, phone_key, workspace_id, purpose, target_type, target_id, requires_otp, expires_at, used_at, revoked_at, open_count, created_by";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function mapLink(raw: Record<string, unknown>): PhoneBoundLink {
  return {
    id: str(raw.id),
    phoneKey: str(raw.phone_key),
    workspaceId: str(raw.workspace_id) || null,
    purpose: str(raw.purpose) as PhoneBoundLinkPurpose,
    targetType: str(raw.target_type),
    targetId: str(raw.target_id),
    requiresOtp: raw.requires_otp === true,
    expiresAt: raw.expires_at ? str(raw.expires_at) : null,
    usedAt: raw.used_at ? str(raw.used_at) : null,
    revokedAt: raw.revoked_at ? str(raw.revoked_at) : null,
    openCount: Number(raw.open_count) || 0,
    createdBy: str(raw.created_by) || null,
  };
}

/** SHA-256 hex of a presented token. The one place a token becomes a database key. */
export function hashPhoneBoundToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function generatePhoneBoundToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isPhoneBoundPurpose(value: unknown): value is PhoneBoundLinkPurpose {
  return typeof value === "string" && (PHONE_BOUND_PURPOSES as string[]).includes(value);
}

/** `/l/<token>` on the canonical origin (the same origin rule the email links use). */
export function buildPhoneBoundLinkUrl(token: string, origin: string = resolveEmailLinkBaseUrl()): string {
  return `${origin.replace(/\/$/, "")}/l/${encodeURIComponent(token)}`;
}

/** When a link of this purpose stops working. Null = until the target closes. */
export function phoneBoundLinkExpiry(purpose: PhoneBoundLinkPurpose, now: Date): Date | null {
  const ttl = PHONE_BOUND_LINK_POLICY[purpose].ttlHours;
  return ttl === "until_closed" ? null : new Date(now.getTime() + ttl * 60 * 60 * 1000);
}

/** How long a verified page session lasts: 30 minutes for money, 7 days otherwise. */
export function linkSessionTtlMs(purpose: PhoneBoundLinkPurpose): number {
  return MONEY_PURPOSES.has(purpose)
    ? SHARED_LINE_OTP_RULES.moneySessionMinutes * 60 * 1000
    : SHARED_LINE_OTP_RULES.otherSessionDays * 24 * 60 * 60 * 1000;
}

export type MintPhoneBoundLinkInput = {
  /** Any phone format; reduced to the 10-digit key. */
  phoneKey: string;
  workspaceId: string;
  purpose: PhoneBoundLinkPurpose;
  targetType: string;
  targetId: string;
  createdBy?: string | null;
  now?: Date;
  /** Override the link origin (a localhost lane server). */
  origin?: string;
};

export class PhoneBoundLinkError extends Error {
  constructor(
    readonly code: "invalid" | "rate_limited" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Mint a link bound to one phone. Only the token's hash is stored; the raw token lives in the
 * returned URL and nowhere else. A newer link for the same phone + purpose + target replaces the
 * older one (the older stops working), so "send it again" leaves exactly one live link.
 */
export async function mintPhoneBoundLink(
  db: SupabaseClient,
  input: MintPhoneBoundLinkInput,
): Promise<{ url: string; linkId: string; token: string; expiresAt: string | null }> {
  const phoneKey = normalizeConsentPhone(input.phoneKey);
  const workspaceId = str(input.workspaceId);
  const targetType = str(input.targetType);
  const targetId = str(input.targetId);
  if (!/^\d{10}$/.test(phoneKey) || !workspaceId || !targetType || !targetId) {
    throw new PhoneBoundLinkError("invalid", "A link needs a phone, a workspace and a target.");
  }
  if (!isPhoneBoundPurpose(input.purpose)) throw new PhoneBoundLinkError("invalid", "Unknown link purpose.");
  if (targetType.length > MAX_TARGET_LENGTH || targetId.length > MAX_TARGET_LENGTH) {
    throw new PhoneBoundLinkError("invalid", "Link target is too long.");
  }

  // A public bearer link must never bridge into a private test namespace.
  const { data: workspace, error: workspaceError } = await db
    .from("portal_workspaces")
    .select("id, owner_user_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (workspaceError || !workspace) throw new PhoneBoundLinkError("unavailable", "Links are unavailable for this workspace.");
  const owner = await resolveTestWorkspaceClassification(str((workspace as Record<string, unknown>).owner_user_id), db);
  if (owner.kind === "classified") throw new PhoneBoundLinkError("unavailable", "Links are unavailable for this workspace.");

  const limited = await rateLimit(
    `phone-bound-mint:${createHash("sha256").update(phoneKey).digest("hex").slice(0, 32)}`,
    PHONE_BOUND_MINTS_PER_PHONE_PER_HOUR,
    60 * 60 * 1000,
  );
  if (!limited.ok) throw new PhoneBoundLinkError("rate_limited", "Too many links were sent to this number. Try again later.");

  const now = input.now ?? new Date();
  const policy = PHONE_BOUND_LINK_POLICY[input.purpose];
  const expires = phoneBoundLinkExpiry(input.purpose, now);

  // Replace, never stack: one live link per phone + purpose + target.
  const { error: supersedeError } = await db
    .from("phone_bound_links")
    .update({ revoked_at: now.toISOString() })
    .eq("phone_key", phoneKey)
    .eq("purpose", input.purpose)
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .is("revoked_at", null)
    .is("used_at", null);
  if (supersedeError && !isMissingSchemaError(supersedeError)) {
    throw new PhoneBoundLinkError("unavailable", "Could not issue the link.");
  }

  const token = generatePhoneBoundToken();
  const { data, error } = await db
    .from("phone_bound_links")
    .insert({
      token_hash: hashPhoneBoundToken(token),
      phone_key: phoneKey,
      workspace_id: workspaceId,
      purpose: input.purpose,
      target_type: targetType,
      target_id: targetId,
      requires_otp: policy.requiresOtp,
      expires_at: expires ? expires.toISOString() : null,
      created_by: str(input.createdBy) || null,
    })
    .select("id")
    .single();
  if (error || !data) throw new PhoneBoundLinkError("unavailable", "Could not issue the link.");

  return {
    url: buildPhoneBoundLinkUrl(token, input.origin ?? resolveEmailLinkBaseUrl()),
    linkId: str((data as Record<string, unknown>).id),
    token,
    expiresAt: expires ? expires.toISOString() : null,
  };
}

/**
 * Resolve a presented token (no auth). Null for an unknown, malformed, revoked, expired or used
 * link, and the caller must not say which. `count: false` is for a read that must not bump the
 * open counter (the code endpoints behind the page).
 */
export async function resolvePhoneBoundLink(
  db: SupabaseClient,
  token: string,
  opts: { count?: boolean; now?: Date } = {},
): Promise<{ link: PhoneBoundLink } | null> {
  const trimmed = String(token ?? "").trim();
  if (!TOKEN_PATTERN.test(trimmed)) return null;
  const { data, error } = await db
    .from("phone_bound_links")
    .select(COLUMNS)
    .eq("token_hash", hashPhoneBoundToken(trimmed))
    .maybeSingle();
  if (error || !data) return null;
  const link = mapLink(data as Record<string, unknown>);
  if (link.revokedAt || link.usedAt) return null;
  const now = opts.now ?? new Date();
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= now.getTime()) return null;
  if (!isPhoneBoundPurpose(link.purpose)) return null;

  if (opts.count !== false) {
    await db.from("phone_bound_links").update({ open_count: link.openCount + 1 }).eq("id", link.id);
  }
  return { link };
}

/** Stop every live link for one target (a job that closed, a charge that was paid). */
export async function revokePhoneBoundLinksForTarget(
  db: SupabaseClient,
  input: { targetType: string; targetId: string; purpose?: PhoneBoundLinkPurpose; now?: Date },
): Promise<number> {
  let query = db
    .from("phone_bound_links")
    .update({ revoked_at: (input.now ?? new Date()).toISOString() })
    .eq("target_type", str(input.targetType))
    .eq("target_id", str(input.targetId))
    .is("revoked_at", null);
  if (input.purpose) query = query.eq("purpose", input.purpose);
  const { data, error } = await query.select("id");
  if (error) {
    if (isMissingSchemaError(error)) return 0;
    throw new Error("Could not revoke links.");
  }
  return Array.isArray(data) ? data.length : 0;
}

/** A single-use outcome (paid, signed, submitted) ends the link: it then reads as expired. */
export async function markPhoneBoundLinkUsed(db: SupabaseClient, linkId: string, now: Date = new Date()): Promise<void> {
  await db
    .from("phone_bound_links")
    .update({ used_at: now.toISOString() })
    .eq("id", str(linkId))
    .is("used_at", null);
}

/**
 * A rent link ends when the charges it names are PAID, not when someone merely opens or starts paying.
 * Called from the Stripe webhook once a charge is confirmed paid (never on `processing`: a bank debit can
 * still fail, and the person must be able to come back to the same link). A link that names several
 * charges ends only when every one is paid; a part-paid link stays open for the balance.
 * Best effort by design: the link page re-derives the same answer on its next open.
 */
export async function settlePhoneBoundRentLinks(
  db: SupabaseClient,
  chargeIds: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  const ids = [...new Set(chargeIds.map((id) => str(id)).filter((id) => /^[A-Za-z0-9_.:-]{1,120}$/.test(id)))];
  if (ids.length === 0) return 0;
  const candidates = new Map<string, { id: string; targetId: string }>();
  for (const id of ids) {
    const { data, error } = await db
      .from("phone_bound_links")
      .select("id, target_id")
      .eq("purpose", "rent")
      .is("used_at", null)
      .is("revoked_at", null)
      .like("target_id", `%${id}%`);
    if (error) {
      if (isMissingSchemaError(error)) return 0;
      throw new Error("Could not read rent links.");
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const targets = str(row.target_id).split(",").map((t) => t.trim());
      if (targets.includes(id)) candidates.set(str(row.id), { id: str(row.id), targetId: str(row.target_id) });
    }
  }
  let settled = 0;
  for (const link of candidates.values()) {
    const named = [...new Set(link.targetId.split(",").map((t) => t.trim()).filter(Boolean))];
    const { data, error } = await db.from("portal_household_charge_records").select("id, status").in("id", named);
    if (error) continue;
    const paid = new Set(((data ?? []) as Array<Record<string, unknown>>).filter((r) => str(r.status) === "paid").map((r) => str(r.id)));
    if (named.every((id) => paid.has(id))) {
      await markPhoneBoundLinkUsed(db, link.id, now);
      settled += 1;
    }
  }
  return settled;
}

// ---------------------------------------------------------------------------------------------
// Verified page sessions (after a one-time code)
// ---------------------------------------------------------------------------------------------

function hashSessionToken(token: string): string {
  return createHash("sha256").update(`pbl-session:${token}`, "utf8").digest("hex");
}

/** Cookie that carries a link's verified session. Keyed on the token hash so two links never share one. */
export function linkSessionCookieName(token: string): string {
  return `pbl_${hashPhoneBoundToken(token).slice(0, 16)}`;
}

/**
 * Open a verified session on one link. 30 minutes for rent and payouts, 7 days otherwise, and
 * never longer than the link itself. Only the session token's hash is stored.
 */
export async function createLinkSession(
  db: SupabaseClient,
  link: Pick<PhoneBoundLink, "id" | "phoneKey" | "purpose" | "expiresAt">,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date; maxAgeSeconds: number } | null> {
  let expiresAt = new Date(now.getTime() + linkSessionTtlMs(link.purpose));
  if (link.expiresAt) {
    const linkEnd = new Date(link.expiresAt);
    if (linkEnd.getTime() < expiresAt.getTime()) expiresAt = linkEnd;
  }
  const maxAgeSeconds = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
  if (maxAgeSeconds <= 0) return null;
  const token = randomBytes(32).toString("base64url");
  const { error } = await db.from("phone_bound_link_sessions").insert({
    session_hash: hashSessionToken(token),
    link_id: link.id,
    phone_key: link.phoneKey,
    expires_at: expiresAt.toISOString(),
  });
  if (error) return null;
  return { token, expiresAt, maxAgeSeconds };
}

/** Is `sessionToken` a live session on exactly this link and phone? */
export async function verifyLinkSession(
  db: SupabaseClient,
  link: Pick<PhoneBoundLink, "id" | "phoneKey">,
  sessionToken: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  const presented = String(sessionToken ?? "").trim();
  if (!TOKEN_PATTERN.test(presented)) return false;
  const { data, error } = await db
    .from("phone_bound_link_sessions")
    .select("link_id, phone_key, expires_at")
    .eq("session_hash", hashSessionToken(presented))
    .maybeSingle();
  if (error || !data) return false;
  const row = data as Record<string, unknown>;
  if (str(row.link_id) !== link.id || str(row.phone_key) !== link.phoneKey) return false;
  return new Date(str(row.expires_at)).getTime() > now.getTime();
}
