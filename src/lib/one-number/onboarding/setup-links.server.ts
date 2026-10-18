import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { generatePhoneBoundToken, hashPhoneBoundToken } from "@/lib/one-number/links.server";
import type { HouseHints } from "@/lib/one-number/onboarding/role-detect";
import { rateLimit } from "@/lib/rate-limit";
import { createHash } from "node:crypto";

/**
 * "Finish setup" links texted after the demo (a landlord) or the vendor intake (a vendor). Like a
 * phone-bound link, only the token's SHA-256 is stored and every refusal reads the same. They are
 * separate from `phone_bound_links` because that service needs an existing workspace and a
 * landlord or vendor texting for the first time has none. A SMS link is bound to the texter's
 * phone: the page texts a code to THAT number only. A web-demo link has no phone; the visitor types
 * one and the page texts it a code.
 */
export type SetupLinkKind = "landlord" | "vendor";

export type SetupLinkContext = HouseHints & {
  source?: "demo" | "direct" | "invite";
  /** The vendor lead this link finishes. */
  vendorLeadId?: string;
};

export type SetupLink = {
  id: string;
  kind: SetupLinkKind;
  phoneKey: string | null;
  context: SetupLinkContext;
  invitedByWorkspaceId: string | null;
  expiresAt: string;
  waitlistedAt: string | null;
  usedAt: string | null;
  userId: string | null;
};

export const SETUP_LINK_TTL_DAYS = 7;
export const SETUP_LINKS_PER_PHONE_PER_HOUR = 10;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const COLUMNS = "id, kind, phone_key, context, invited_by_workspace_id, expires_at, waitlisted_at, used_at, revoked_at, user_id";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

function toLink(row: Row): SetupLink {
  const ctx = row.context && typeof row.context === "object" && !Array.isArray(row.context) ? (row.context as SetupLinkContext) : {};
  return {
    id: str(row.id),
    kind: str(row.kind) === "vendor" ? "vendor" : "landlord",
    phoneKey: str(row.phone_key) || null,
    context: ctx,
    invitedByWorkspaceId: str(row.invited_by_workspace_id) || null,
    expiresAt: str(row.expires_at),
    waitlistedAt: row.waitlisted_at ? str(row.waitlisted_at) : null,
    usedAt: row.used_at ? str(row.used_at) : null,
    userId: str(row.user_id) || null,
  };
}

export function buildSetupLinkUrl(token: string, origin: string = resolveEmailLinkBaseUrl()): string {
  return `${origin.replace(/\/$/, "")}/start/${encodeURIComponent(token)}`;
}

export type MintSetupLinkResult = { ok: true; url: string; linkId: string; token: string } | { ok: false; reason: "rate_limited" | "unavailable" };

/** Mint a link. A newer unused link for the same phone + kind replaces the older one. */
export async function mintSetupLink(
  db: SupabaseClient,
  input: {
    kind: SetupLinkKind;
    phoneKey: string | null;
    context?: SetupLinkContext;
    invitedByWorkspaceId?: string | null;
    origin?: string;
    now?: Date;
  },
): Promise<MintSetupLinkResult> {
  const now = input.now ?? new Date();
  if (input.phoneKey) {
    const limited = await rateLimit(
      `setup-link-mint:${createHash("sha256").update(input.phoneKey).digest("hex").slice(0, 32)}`,
      SETUP_LINKS_PER_PHONE_PER_HOUR,
      60 * 60 * 1000,
    );
    if (!limited.ok) return { ok: false, reason: "rate_limited" };
    const { error: supersedeError } = await db
      .from("sms_setup_links")
      .update({ revoked_at: now.toISOString() })
      .eq("phone_key", input.phoneKey)
      .eq("kind", input.kind)
      .is("revoked_at", null)
      .is("used_at", null);
    if (supersedeError && !isMissingSchemaError(supersedeError)) return { ok: false, reason: "unavailable" };
  }
  const token = generatePhoneBoundToken();
  const expires = new Date(now.getTime() + SETUP_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
  const { data, error } = await db
    .from("sms_setup_links")
    .insert({
      token_hash: hashPhoneBoundToken(token),
      kind: input.kind,
      phone_key: input.phoneKey,
      context: input.context ?? {},
      invited_by_workspace_id: input.invitedByWorkspaceId ?? null,
      expires_at: expires.toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "unavailable" };
  return { ok: true, url: buildSetupLinkUrl(token, input.origin), linkId: str((data as Row).id), token };
}

/** The live link behind a token, or null (unknown, malformed, expired, revoked: all the same). */
export async function resolveSetupLink(db: SupabaseClient, token: string, now: Date = new Date()): Promise<SetupLink | null> {
  const trimmed = token.trim();
  if (!TOKEN_PATTERN.test(trimmed)) return null;
  const { data, error } = await db.from("sms_setup_links").select(COLUMNS).eq("token_hash", hashPhoneBoundToken(trimmed)).maybeSingle();
  if (error || !data) return null;
  const row = data as Row;
  if (row.revoked_at) return null;
  const link = toLink(row);
  if (!link.expiresAt || new Date(link.expiresAt).getTime() <= now.getTime()) return null;
  return link;
}

export async function markSetupLinkUsed(db: SupabaseClient, linkId: string, userId: string, now: Date = new Date()): Promise<void> {
  await db.from("sms_setup_links").update({ used_at: now.toISOString(), user_id: userId, waitlisted_at: null }).eq("id", linkId).is("used_at", null);
}

export async function markSetupLinkWaitlisted(db: SupabaseClient, linkId: string, userId: string, now: Date = new Date()): Promise<void> {
  await db.from("sms_setup_links").update({ waitlisted_at: now.toISOString(), user_id: userId }).eq("id", linkId).is("used_at", null);
}

/** Landlords that finished setup by text (the waitlist cap counts these). */
export async function countFinishedLandlordSetups(db: SupabaseClient): Promise<number | null> {
  const { count, error } = await db
    .from("sms_setup_links")
    .select("id", { count: "exact", head: true })
    .eq("kind", "landlord")
    .not("used_at", "is", null);
  return error ? null : (count ?? 0);
}
