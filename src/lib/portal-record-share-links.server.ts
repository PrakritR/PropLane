import "server-only";

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type PortalRecordShareKind = "lease" | "application";

export type PortalRecordShareLinkRow = {
  id: string;
  recordKind: PortalRecordShareKind;
  recordId: string;
  shareToken: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  accessCount: number;
};

function mapShareLinkRow(raw: Record<string, unknown>): PortalRecordShareLinkRow {
  return {
    id: String(raw.id),
    recordKind: String(raw.record_kind) as PortalRecordShareKind,
    recordId: String(raw.record_id),
    shareToken: String(raw.share_token),
    expiresAt: String(raw.expires_at),
    createdAt: String(raw.created_at),
    revokedAt: raw.revoked_at ? String(raw.revoked_at) : null,
    accessCount: Number(raw.access_count) || 0,
  };
}

function generateShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export function buildPortalRecordShareUrl(origin: string, kind: PortalRecordShareKind, token: string): string {
  const base = origin.replace(/\/$/, "");
  const segment = kind === "lease" ? "leases" : "applications";
  return `${base}/share/${segment}/${encodeURIComponent(token)}`;
}

export async function createPortalRecordShareLink(
  db: SupabaseClient,
  input: {
    recordKind: PortalRecordShareKind;
    recordId: string;
    managerUserId: string;
    createdBy: string;
    expiresInDays?: number;
  },
): Promise<PortalRecordShareLinkRow> {
  const expiresInDays = Math.min(90, Math.max(1, input.expiresInDays ?? 14));
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const shareToken = generateShareToken();

  const { data, error } = await db
    .from("portal_record_share_links")
    .insert({
      record_kind: input.recordKind,
      record_id: input.recordId.trim(),
      manager_user_id: input.managerUserId,
      share_token: shareToken,
      expires_at: expiresAt,
      created_by: input.createdBy,
    })
    .select("id, record_kind, record_id, share_token, expires_at, created_at, revoked_at, access_count")
    .single();

  if (error) throw new Error(error.message);
  return mapShareLinkRow(data as Record<string, unknown>);
}

export type ResolvedPortalRecordShareLink = {
  link: PortalRecordShareLinkRow;
  managerUserId: string;
};

/** Resolve a public share token (no auth). */
export async function resolvePortalRecordShareToken(
  db: SupabaseClient,
  token: string,
): Promise<ResolvedPortalRecordShareLink | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const { data: linkRow, error } = await db
    .from("portal_record_share_links")
    .select("id, record_kind, record_id, share_token, expires_at, created_at, revoked_at, access_count, manager_user_id")
    .eq("share_token", trimmed)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !linkRow) return null;
  if (new Date(String(linkRow.expires_at)).getTime() < Date.now()) return null;

  await db
    .from("portal_record_share_links")
    .update({
      access_count: (Number(linkRow.access_count) || 0) + 1,
      last_accessed_at: new Date().toISOString(),
    })
    .eq("id", linkRow.id);

  return {
    link: mapShareLinkRow(linkRow as Record<string, unknown>),
    managerUserId: String(linkRow.manager_user_id),
  };
}
