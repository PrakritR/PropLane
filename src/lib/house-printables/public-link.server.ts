import "server-only";

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The opaque token behind a house's public QR. One active token per property;
 * revoking it kills every poster and door card that carries it, and the next
 * issue mints a fresh one. The token is random, never a property id, so a poster
 * cannot be turned into an enumeration of the manager's homes.
 */
export type HousePublicLink = {
  id: string;
  propertyId: string;
  managerUserId: string;
  token: string;
  createdAt: string;
  revokedAt: string | null;
};

const SELECT = "id, property_id, manager_user_id, token, created_at, revoked_at";

function mapRow(raw: Record<string, unknown>): HousePublicLink {
  return {
    id: String(raw.id),
    propertyId: String(raw.property_id),
    managerUserId: String(raw.manager_user_id),
    token: String(raw.token),
    createdAt: String(raw.created_at),
    revokedAt: raw.revoked_at ? String(raw.revoked_at) : null,
  };
}

export function buildHousePublicUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/h/${encodeURIComponent(token)}`;
}

/** The active link for a property, or null when none has been issued. */
export async function findHousePublicLink(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
): Promise<HousePublicLink | null> {
  const { data, error } = await db
    .from("manager_house_public_links")
    .select(SELECT)
    .eq("manager_user_id", managerUserId)
    .eq("property_id", propertyId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapRow(data as Record<string, unknown>) : null;
}

/** Reuse the active link or mint one — a reprint must not change the address on the wall. */
export async function ensureHousePublicLink(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
): Promise<HousePublicLink> {
  const existing = await findHousePublicLink(db, managerUserId, propertyId);
  if (existing) return existing;
  const { data, error } = await db
    .from("manager_house_public_links")
    .insert({
      property_id: propertyId,
      manager_user_id: managerUserId,
      token: randomBytes(9).toString("base64url"),
    })
    .select(SELECT)
    .single();
  if (error) {
    // Two prints at once: the partial unique index let exactly one in. Read it.
    if (error.code === "23505") {
      const won = await findHousePublicLink(db, managerUserId, propertyId);
      if (won) return won;
    }
    throw new Error(error.message);
  }
  return mapRow(data as Record<string, unknown>);
}

/** Revoke every active link for the property. Returns how many stopped working. */
export async function revokeHousePublicLinks(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
): Promise<number> {
  const { data, error } = await db
    .from("manager_house_public_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("manager_user_id", managerUserId)
    .eq("property_id", propertyId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

/** Resolve a scanned token (no auth). Null for unknown or revoked. */
export async function resolveHousePublicToken(
  db: SupabaseClient,
  token: string,
): Promise<HousePublicLink | null> {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 64) return null;
  const { data, error } = await db
    .from("manager_house_public_links")
    .select(SELECT)
    .eq("token", trimmed)
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
