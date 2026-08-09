/**
 * Manager API key lifecycle — mint, list, revoke, look up.
 *
 * The plaintext token exists exactly once, in the return value of `mintApiKey`,
 * and is never persisted or logged. Everything afterwards works off the sha256
 * hex, which is the unique lookup key. A caller that loses the token mints a
 * new one; there is no recovery path by design.
 */
import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { API_KEY_TOOL_NAMES, type ApiKeyTransport } from "./capabilities";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Product-area selections are stored as `area:read` / `area:write`. */
export type ApiKeyScope = string;

const TOKEN_PREFIX = "pl_live_";
/** Enough of the token to name it in the UI without being usable on its own. */
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 4;
/** Skip the `last_used_at` write when the stored value is younger than this. */
const LAST_USED_REFRESH_MS = 60_000;

export type ApiKeyRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiKeyScope[];
  allowedTools: string[];
  transport: ApiKeyTransport;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export function hashApiKeyToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Normalize stored labels for display. Authorization never trusts this field:
 * `allowed_tools` is the executable, exact permission list.
 */
export function normalizeScopes(raw: unknown): ApiKeyScope[] {
  return Array.isArray(raw)
    ? Array.from(new Set(raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean)))
    : [];
}

export function normalizeAllowedTools(raw: unknown): string[] {
  return Array.isArray(raw)
    ? Array.from(
        new Set(raw.map((tool) => String(tool).trim()).filter((tool) => API_KEY_TOOL_NAMES.has(tool))),
      )
    : [];
}

export function normalizeTransport(raw: unknown): ApiKeyTransport {
  return raw === "api" ? "api" : "mcp";
}

function rowToApiKey(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    tokenPrefix: String(row.token_prefix ?? ""),
    scopes: normalizeScopes(row.scopes),
    allowedTools: normalizeAllowedTools(row.allowed_tools),
    transport: normalizeTransport(row.transport),
    createdAt: String(row.created_at ?? ""),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
}

/**
 * Create a key for `userId`. Returns the row AND the plaintext token — the
 * single moment it exists. Callers must hand it straight to the response body
 * and never log it.
 */
export async function mintApiKey(
  db: Db,
  args: {
    userId: string;
    name: string;
    scopes: ApiKeyScope[];
    allowedTools: string[];
    transport: ApiKeyTransport;
    expiresAt?: string | null;
  },
): Promise<{ key: ApiKeyRow; token: string } | null> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const { data, error } = await db
    .from("manager_api_keys")
    .insert({
      user_id: args.userId,
      name: args.name.trim().slice(0, 80) || "Untitled key",
      token_prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
      token_sha256: hashApiKeyToken(token),
      scopes: normalizeScopes(args.scopes),
      allowed_tools: normalizeAllowedTools(args.allowedTools),
      transport: normalizeTransport(args.transport),
      portal: "manager",
      expires_at: args.expiresAt ?? null,
    })
    .select("id, name, token_prefix, scopes, allowed_tools, transport, created_at, last_used_at, expires_at, revoked_at")
    .single();

  if (error || !data) {
    // The token is deliberately absent from this log line.
    console.error("[mcp] api key insert failed", { error: error?.message ?? "no row returned" });
    return null;
  }
  return { key: rowToApiKey(data as Record<string, unknown>), token };
}

/** Every key for a manager, newest first. Never includes a token. */
export async function listApiKeys(db: Db, userId: string): Promise<ApiKeyRow[]> {
  const { data, error } = await db
    .from("manager_api_keys")
    .select("id, name, token_prefix, scopes, allowed_tools, transport, created_at, last_used_at, expires_at, revoked_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[mcp] api key list failed", { error: error.message });
    return [];
  }
  return (data ?? []).map((row) => rowToApiKey(row as Record<string, unknown>));
}

/**
 * Revoke one key. Scoped on `user_id` as well as `id` so knowing another
 * manager's key id is not enough to disable it.
 */
export async function revokeApiKey(db: Db, userId: string, id: string): Promise<boolean> {
  const { data, error } = await db
    .from("manager_api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[mcp] api key revoke failed", { error: error.message });
    return false;
  }
  return Boolean(data?.id);
}

export type ResolvedApiKey = {
  id: string;
  userId: string;
  scopes: ApiKeyScope[];
  allowedTools: string[];
  transport: ApiKeyTransport;
  portal: string;
  lastUsedAt: string | null;
};

/**
 * Look up a live key by its plaintext token. Returns null for an unknown,
 * revoked, or expired token — the caller must not distinguish those cases to
 * the client.
 */
export async function findLiveApiKey(db: Db, token: string): Promise<ResolvedApiKey | null> {
  const hash = hashApiKeyToken(token);
  const { data, error } = await db
    .from("manager_api_keys")
    .select("id, user_id, scopes, allowed_tools, transport, portal, token_sha256, expires_at, revoked_at, last_used_at")
    .eq("token_sha256", hash)
    .maybeSingle();
  if (error || !data) return null;

  // The row was fetched BY the hash, so this compare can only fail on a
  // driver-level surprise. It costs nothing and keeps the comparison constant
  // time regardless of how the row was obtained.
  const stored = String(data.token_sha256 ?? "");
  if (stored.length !== hash.length) return null;
  if (!timingSafeEqual(Buffer.from(stored, "utf8"), Buffer.from(hash, "utf8"))) return null;

  if (data.revoked_at) return null;
  if (data.expires_at && new Date(String(data.expires_at)).getTime() <= Date.now()) return null;

  return {
    id: String(data.id),
    userId: String(data.user_id),
    scopes: normalizeScopes(data.scopes),
    allowedTools: normalizeAllowedTools(data.allowed_tools),
    transport: normalizeTransport(data.transport),
    portal: String(data.portal ?? "manager"),
    lastUsedAt: data.last_used_at ? String(data.last_used_at) : null,
  };
}

/**
 * Best-effort `last_used_at` refresh, throttled so a busy agent does not cost
 * one UPDATE per tool call. Fire-and-forget: a failure here must never fail the
 * request the manager is actually waiting on.
 *
 * ponytail: throttle is per-row wall clock, not a counter. Good enough for a
 * "last seen" column; add real usage metering only if someone needs to bill on it.
 */
export function touchApiKey(db: Db, key: ResolvedApiKey): void {
  const last = key.lastUsedAt ? new Date(key.lastUsedAt).getTime() : 0;
  if (Date.now() - last < LAST_USED_REFRESH_MS) return;
  void db
    .from("manager_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.id)
    .then(undefined, () => {
      /* never break a request over a usage timestamp */
    });
}
