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
import type { AgentWorkspaceScope } from "@/lib/agent/manager-workspace-scope";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { findLiveApiKey, touchApiKey, type ApiKeyScope } from "./api-keys.server";
import type { ApiKeyTransport } from "./capabilities";
import { findLiveMcpAccessToken, touchMcpAccessToken, type McpPortal } from "./oauth.server";
import { API_KEY_TOOL_NAMES } from "./capabilities";
import { withholdManagerSurface } from "@/lib/property-owner/access.server";
import { resolveManagerSmsAccess } from "@/lib/sms/manager-sms-access.server";
import { resolveResidentAgentContextForUser, type ResidentAgentContext } from "@/lib/tools/resident-context";
import { loadWorkspaces } from "@/lib/workspaces/server";

/**
 * The same `AgentWorkspaceScope` shape `resolveAgentContext` builds from a
 * browser session's selection cookie (W001) — resolved here from the
 * workspace id STORED ON THE CREDENTIAL instead, since a bearer request has
 * no cookie. Returns null when the credential carries no workspace at all (a
 * pre-migration row that has not backfilled, or the resolve itself failed),
 * so the caller can refuse rather than build an `AgentContext` with
 * `workspace: undefined` — the shape every tool's `!workspace => allow`
 * fallback reads as "workspace scoping does not apply here", which is
 * exactly how an API key used to reach every workspace a manager owns.
 */
async function resolveApiKeyWorkspaceScope(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  workspaceId: string | null,
): Promise<AgentWorkspaceScope | null> {
  const id = (workspaceId ?? "").trim();
  if (!id) return null;
  try {
    // STRICT, unlike `resolveActiveWorkspace`, which falls back to the viewer's own default when a selection no
    // longer resolves. A connection approved for a staffed PropLane Service workspace whose seat was since
    // revoked must lose that workspace, not silently land on the holder's own. `loadWorkspaces` is the list the
    // service shell and `resolveAgentContext` read, so membership, owner of record and house scope are theirs.
    const workspaces = await loadWorkspaces(db, userId);
    const active = workspaces.find((w) => w.id === id);
    if (!active) return null;
    return {
      id: active.id,
      name: active.name,
      isDefault: active.isDefault,
      narrowing: workspaces.length > 1,
      propertyIds: active.propertyIds.map((pid) => pid.trim()).filter(Boolean),
    };
  } catch {
    return null;
  }
}

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

type LiveOauthToken = NonNullable<Awaited<ReturnType<typeof findLiveMcpAccessToken>>>;

export async function resolveApiKeyContext(
  req: Request,
  expectedTransport: ApiKeyTransport = "mcp",
  preloadedOauthToken?: LiveOauthToken | null,
): Promise<ResolveApiKeyResult> {
  const token = bearerTokenFrom(req);
  if (!token) {
    return { ok: false, status: 401, error: "Missing API key. Send an Authorization: Bearer header." };
  }

  const db = createSupabaseServiceRoleClient();
  const key = await findLiveApiKey(db, token);
  const oauthToken = key || expectedTransport !== "mcp" ? null : preloadedOauthToken !== undefined ? preloadedOauthToken : await findLiveMcpAccessToken(db, token);
  // Unknown, revoked and expired are one indistinguishable answer on purpose.
  if (!key && !oauthToken) return { ok: false, status: 401, error: "Invalid or revoked API key." };
  // The row is future-proofed for resident/vendor credentials, but this
  // resolver exposes only the manager registry. Never let a future portal key
  // silently inherit manager tools just because it shares a table.
  if (key && key.portal !== "manager") return { ok: false, status: 401, error: "Invalid or revoked API key." };
  // The same wall for an OAuth connection: a resident connection's token is never a manager credential.
  if (oauthToken && oauthToken.portal !== "manager") return { ok: false, status: 401, error: "Invalid or revoked API key." };
  const keyTransport = oauthToken ? "mcp" : key!.transport ?? "mcp";
  if (keyTransport !== expectedTransport) {
    return {
      ok: false,
      status: 401,
      error: `This key is for the ${keyTransport === "mcp" ? "MCP" : "REST API"} endpoint.`,
    };
  }

  // Same role predicate as resolveAgentContext (src/lib/tools/context.ts).
  const [{ data: profile, error: profileError }, { data: roleRows, error: roleError }] = await Promise.all([
    db.from("profiles").select("email").eq("id", key?.userId ?? oauthToken!.userId).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", key?.userId ?? oauthToken!.userId),
  ]);
  const userId = key?.userId ?? oauthToken!.userId;
  if (profileError || roleError) return { ok: false, status: 403, error: "This account no longer has manager access." };
  const roles = (roleRows ?? []).map((r) => String(r.role).toLowerCase());
  const isAdmin = roles.includes("admin");
  const isManagerOrOwner = roles.includes("manager") || roles.includes("owner");
  if (!isAdmin && !isManagerOrOwner) {
    return { ok: false, status: 403, error: "This account no longer has manager access." };
  }
  // Same two decisions `resolveAgentContext` makes, so a bearer connection reaches exactly what the signed-in
  // seat reaches: a Property owner's seat is not the manager assistant, and a co-manager / PropLane Service
  // staff seat widens through `managerSmsAccess` (without it every tool filters on `landlordId` alone and a
  // pure seat holder reads an empty workspace).
  if (!isAdmin && (await withholdManagerSurface(db, userId))) {
    return { ok: false, status: 403, error: "This account no longer has manager access." };
  }
  const managerSmsAccess = (await resolveManagerSmsAccess(db, { actorUserId: userId, workNumberOwnerId: userId })) ?? undefined;

  // Every tool call made through this credential must land inside ONE
  // workspace, resolved from what the key/connection was scoped to at mint
  // (or approval) time — never left `undefined`, which every module's
  // `!workspace => allow` fallback reads as "don't narrow" (W001).
  const storedWorkspaceId = key?.workspaceId ?? oauthToken?.workspaceId ?? null;
  const workspace = await resolveApiKeyWorkspaceScope(db, userId, storedWorkspaceId);
  if (!workspace) {
    return {
      ok: false,
      status: 403,
      error: "This key has no workspace scope. Recreate it from Settings › API & MCP.",
    };
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
      workspace,
      db,
      managerSmsAccess,
    },
  };
}

export type McpBearerContext =
  | ({ ok: true; portal: "manager" } & ApiKeyContext)
  | { ok: true; portal: "resident"; keyId: string; ctx: ResidentAgentContext }
  | { ok: false; status: 401 | 403; error: string };

/**
 * The one resolver `/api/mcp` calls. A connection is bound at consent to exactly one portal, and that binding
 * (`mcp_oauth_tokens.portal`, never the request) picks the context type: a manager connection goes through
 * `resolveApiKeyContext` (the manager `AgentContext`), a resident connection through
 * `resolveResidentAgentContextForUser` (the resident portal's own context, re-derived every request, scoped by
 * `resident_user_id`). The two never share a branch and the caller dispatches on `portal`.
 */
export async function resolveMcpBearerContext(req: Request): Promise<McpBearerContext> {
  const token = bearerTokenFrom(req);
  if (!token) return { ok: false, status: 401, error: "Missing API key. Send an Authorization: Bearer header." };
  const db = createSupabaseServiceRoleClient();
  // `findLiveApiKey` tokens never carry the OAuth prefix, so this is a prefix check, not a query, for a key.
  const oauth = await findLiveMcpAccessToken(db, token);
  if (oauth?.portal === "resident") {
    const ctx = await resolveResidentAgentContextForUser(oauth.userId);
    if (!ctx) return { ok: false, status: 403, error: "This account no longer has a resident portal." };
    touchMcpAccessToken(db, oauth);
    return { ok: true, portal: "resident", keyId: `oauth:${oauth.id}`, ctx };
  }
  const manager = await resolveApiKeyContext(req, "mcp", oauth);
  return manager.ok ? { ...manager, portal: "manager" } : manager;
}

export type { McpPortal };
