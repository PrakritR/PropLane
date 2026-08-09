/** OAuth 2.1 state for browser-authenticated remote MCP clients. */
import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

const ACCESS_PREFIX = "pl_mcp_at_";
const REFRESH_PREFIX = "pl_mcp_rt_";
const CLIENT_PREFIX = "pl_mcp_client_";
const AUTH_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;

export const MCP_OAUTH_SCOPE = "mcp:tools";

type ApprovalPayload = { userId: string; clientId: string; redirectUri: string; codeChallenge: string; scope: string; state: string; expiresAt: number };

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function approvalSecret(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

/** A short-lived, user-bound anti-CSRF token for the browser consent POST. */
export function signMcpApproval(payload: Omit<ApprovalPayload, "expiresAt">): string | null {
  const secret = approvalSecret();
  if (!secret) return null;
  const encoded = Buffer.from(JSON.stringify({ ...payload, expiresAt: Date.now() + 10 * 60_000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyMcpApproval(token: string): ApprovalPayload | null {
  const secret = approvalSecret();
  const [encoded, signature, extra] = token.split(".");
  if (!secret || !encoded || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ApprovalPayload;
    return typeof payload.userId === "string" && typeof payload.clientId === "string" && typeof payload.redirectUri === "string" && typeof payload.codeChallenge === "string" && typeof payload.scope === "string" && typeof payload.state === "string" && Number.isFinite(payload.expiresAt) && payload.expiresAt > Date.now() ? payload : null;
  } catch { return null; }
}

export function isSafeOAuthRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

export async function registerMcpOAuthClient(
  db: Db,
  input: { clientName?: string; redirectUris: string[] },
): Promise<{ clientId: string; clientName: string | null; redirectUris: string[] } | null> {
  const redirectUris = Array.from(new Set(input.redirectUris.filter(isSafeOAuthRedirectUri)));
  if (redirectUris.length === 0) return null;
  const clientId = randomToken(CLIENT_PREFIX);
  const { data, error } = await db
    .from("mcp_oauth_clients")
    .insert({ client_id: clientId, client_name: input.clientName?.trim().slice(0, 120) || null, redirect_uris: redirectUris })
    .select("client_id, client_name, redirect_uris")
    .single();
  if (error || !data) return null;
  return { clientId: String(data.client_id), clientName: data.client_name ? String(data.client_name) : null, redirectUris: data.redirect_uris as string[] };
}

export async function getMcpOAuthClient(db: Db, clientId: string) {
  const { data } = await db.from("mcp_oauth_clients").select("client_id, client_name, redirect_uris").eq("client_id", clientId).maybeSingle();
  if (!data) return null;
  return { clientId: String(data.client_id), clientName: data.client_name ? String(data.client_name) : null, redirectUris: Array.isArray(data.redirect_uris) ? data.redirect_uris.map(String) : [] };
}

export async function createMcpAuthorizationCode(
  db: Db,
  input: { userId: string; clientId: string; redirectUri: string; codeChallenge: string; scopes: string[] },
): Promise<string | null> {
  const code = randomToken("pl_mcp_code_");
  const { error } = await db.from("mcp_oauth_authorization_codes").insert({
    code_sha256: sha256(code), user_id: input.userId, client_id: input.clientId, redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge, scopes: input.scopes, expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
  });
  return error ? null : code;
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const actual = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return actual.length === challenge.length && timingSafeEqual(Buffer.from(actual), Buffer.from(challenge));
}

export async function exchangeMcpAuthorizationCode(db: Db, input: { code: string; clientId: string; redirectUri: string; codeVerifier: string }) {
  const codeHash = sha256(input.code);
  const { data } = await db.from("mcp_oauth_authorization_codes").select("id, user_id, client_id, redirect_uri, code_challenge, scopes, expires_at, claimed_at").eq("code_sha256", codeHash).maybeSingle();
  if (!data || data.claimed_at || String(data.client_id) !== input.clientId || String(data.redirect_uri) !== input.redirectUri || new Date(String(data.expires_at)).getTime() <= Date.now() || !pkceMatches(input.codeVerifier, String(data.code_challenge))) return null;
  const { data: claimed } = await db.from("mcp_oauth_authorization_codes").update({ claimed_at: new Date().toISOString() }).eq("id", data.id).is("claimed_at", null).select("id").maybeSingle();
  if (!claimed) return null;
  return createMcpAccessTokens(db, { userId: String(data.user_id), clientId: input.clientId, scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [MCP_OAUTH_SCOPE] });
}

async function createMcpAccessTokens(db: Db, input: { userId: string; clientId: string; scopes: string[] }) {
  const accessToken = randomToken(ACCESS_PREFIX);
  const refreshToken = randomToken(REFRESH_PREFIX);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
  const { data, error } = await db.from("mcp_oauth_tokens").insert({
    access_token_sha256: sha256(accessToken), refresh_token_sha256: sha256(refreshToken), user_id: input.userId,
    client_id: input.clientId, scopes: input.scopes, expires_at: expiresAt,
  }).select("id").single();
  if (error || !data) return null;
  return { accessToken, refreshToken, expiresAt, scopes: input.scopes };
}

export async function refreshMcpAccessToken(db: Db, input: { refreshToken: string; clientId: string }) {
  const hash = sha256(input.refreshToken);
  const { data } = await db.from("mcp_oauth_tokens").select("id, user_id, client_id, scopes, revoked_at").eq("refresh_token_sha256", hash).maybeSingle();
  if (!data || data.revoked_at || String(data.client_id) !== input.clientId) return null;
  const { data: revoked } = await db.from("mcp_oauth_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", data.id).is("revoked_at", null).select("id").maybeSingle();
  if (!revoked) return null;
  return createMcpAccessTokens(db, { userId: String(data.user_id), clientId: input.clientId, scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [MCP_OAUTH_SCOPE] });
}

export async function findLiveMcpAccessToken(db: Db, token: string): Promise<{ id: string; userId: string; scopes: string[]; lastUsedAt: string | null } | null> {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const hash = sha256(token);
  const { data } = await db.from("mcp_oauth_tokens").select("id, user_id, access_token_sha256, scopes, expires_at, revoked_at, last_used_at").eq("access_token_sha256", hash).maybeSingle();
  if (!data || data.revoked_at || new Date(String(data.expires_at)).getTime() <= Date.now()) return null;
  const stored = String(data.access_token_sha256 ?? "");
  if (stored.length !== hash.length || !timingSafeEqual(Buffer.from(stored), Buffer.from(hash))) return null;
  return { id: String(data.id), userId: String(data.user_id), scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [], lastUsedAt: data.last_used_at ? String(data.last_used_at) : null };
}

export function touchMcpAccessToken(db: Db, token: { id: string; lastUsedAt: string | null }): void {
  const then = token.lastUsedAt ? new Date(token.lastUsedAt).getTime() : 0;
  if (Date.now() - then < 60_000) return;
  void db.from("mcp_oauth_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", token.id).then(undefined, () => undefined);
}
