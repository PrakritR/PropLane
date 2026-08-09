/**
 * Bearer-token → `AgentContext` for the MCP server and the public tool API.
 *
 * This is the fourth context resolver (after the manager / resident / vendor
 * cookie-session ones) and the only one not bound to a browser session. It
 * produces the SAME `AgentContext` shape as `resolveAgentContext`, which is
 * what lets every existing manager tool work over MCP with zero per-tool edits.
 *
 * THE INVARIANT: an API key is a credential, never standing authorization. The
 * manager/owner role is re-derived from `profile_roles` on EVERY request using
 * the same predicate `resolveAgentContext` uses, so an account that loses the
 * role loses every key with it, that same request. Never cache the role onto
 * the key row.
 *
 * Cookies are ignored entirely. The MCP route answers permissive CORS, which is
 * only safe because nothing here reads ambient credentials — if this function
 * ever consults a cookie, that CORS header becomes a CSRF hole.
 */
import "server-only";

import type { AgentContext } from "@/lib/tools/context";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { findLiveApiKey, touchApiKey, type ApiKeyScope } from "./api-keys.server";
import type { ApiKeyTransport } from "./capabilities";
import { findLiveMcpAccessToken, touchMcpAccessToken } from "./oauth.server";
import { API_KEY_TOOL_NAMES } from "./capabilities";

export type ApiKeyContext = {
  ctx: AgentContext;
  keyId: string;
  scopes: ApiKeyScope[];
  allowedTools: string[];
};

export type ResolveApiKeyResult =
  | ({ ok: true } & ApiKeyContext)
  | { ok: false; status: 401 | 403; error: string };

/** `Authorization: Bearer <token>`, case-insensitive scheme. Null when absent. */
export function bearerTokenFrom(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

export async function resolveApiKeyContext(
  req: Request,
  expectedTransport: ApiKeyTransport = "mcp",
): Promise<ResolveApiKeyResult> {
  const token = bearerTokenFrom(req);
  if (!token) {
    return { ok: false, status: 401, error: "Missing API key. Send an Authorization: Bearer header." };
  }

  const db = createSupabaseServiceRoleClient();
  const key = await findLiveApiKey(db, token);
  const oauthToken = !key && expectedTransport === "mcp" ? await findLiveMcpAccessToken(db, token) : null;
  // Unknown, revoked and expired are one indistinguishable answer on purpose.
  if (!key && !oauthToken) return { ok: false, status: 401, error: "Invalid or revoked API key." };
  // The row is future-proofed for resident/vendor credentials, but this
  // resolver exposes only the manager registry. Never let a future portal key
  // silently inherit manager tools just because it shares a table.
  if (key && key.portal !== "manager") return { ok: false, status: 401, error: "Invalid or revoked API key." };
  const keyTransport = oauthToken ? "mcp" : key!.transport ?? "mcp";
  if (keyTransport !== expectedTransport) {
    return {
      ok: false,
      status: 401,
      error: `This key is for the ${keyTransport === "mcp" ? "MCP" : "REST API"} endpoint.`,
    };
  }

  // Same role predicate as resolveAgentContext (src/lib/tools/context.ts).
  const [{ data: profile }, { data: roleRows }] = await Promise.all([
    db.from("profiles").select("email, role").eq("id", key?.userId ?? oauthToken!.userId).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", key?.userId ?? oauthToken!.userId),
  ]);
  // Do NOT call `isAdminUser` here: it resolves a cookie-backed Supabase
  // client for portal-preview behavior. This endpoint deliberately ignores
  // ambient cookies so its bearer-only wildcard CORS policy stays CSRF-safe.
  const userId = key?.userId ?? oauthToken!.userId;
  const isAdmin = await userHoldsAdminRole(db, userId);
  const roleList = (roleRows ?? []).map((r) => String(r.role).toLowerCase());
  const legacyRole = String(profile?.role ?? "").toLowerCase();
  const roles = roleList.length > 0 ? roleList : legacyRole ? [legacyRole] : [];
  const isManagerOrOwner = roles.some((r) => r === "manager" || r === "owner");
  if (!isAdmin && !isManagerOrOwner) {
    return { ok: false, status: 403, error: "This account no longer has manager access." };
  }

  if (key) touchApiKey(db, key);
  else if (oauthToken) touchMcpAccessToken(db, oauthToken);

  return {
    ok: true,
    keyId: key?.id ?? `oauth:${oauthToken!.id}`,
    scopes: key?.scopes ?? ["mcp:tools"],
    allowedTools: key?.allowedTools ?? Array.from(API_KEY_TOOL_NAMES),
    ctx: {
      landlordId: userId,
      userId,
      email: (profile?.email ?? "").trim().toLowerCase(),
      roles,
      isAdmin,
      db,
    },
  };
}
