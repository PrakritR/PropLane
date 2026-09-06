/**
 * Manager API key management. Cookie-session authorized (this is the portal UI
 * talking, not an agent), service-role backed because `manager_api_keys` is
 * RLS-default-deny.
 *
 * GET returns prefixes only. The plaintext token exists in exactly one place
 * ever: the POST response body.
 */
import { NextResponse } from "next/server";

import { resolveAgentContext } from "@/lib/tools/context";
import { listApiKeys, mintApiKey, normalizeAllowedTools, normalizeScopes } from "@/lib/mcp/api-keys.server";
import { API_KEY_WRITE_TOOL_NAMES, productAreaSelectionsForTools } from "@/lib/mcp/capabilities";
import { track } from "@/lib/analytics/posthog";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** A manager with more open keys than this is almost certainly not curating them. */
const MAX_ACTIVE_KEYS = 20;

export async function GET() {
  const actor = await resolveAgentContext();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return NextResponse.json({ keys: await listApiKeys(actor.db, actor.userId) });
}

export async function POST(req: Request) {
  const actor = await resolveAgentContext();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await rateLimit(`api-key-create:${actor.userId}`, 10, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  let body: { name?: unknown; scopes?: unknown; allowedTools?: unknown; transport?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Give the key a name." }, { status: 400 });

  const existing = await listApiKeys(actor.db, actor.userId);
  if (existing.length >= MAX_ACTIVE_KEYS) {
    return NextResponse.json(
      { error: `You already have ${MAX_ACTIVE_KEYS} active keys. Revoke one first.` },
      { status: 400 },
    );
  }

  // Remote MCP uses OAuth + PKCE only. Never let a direct POST mint a
  // long-lived static bearer credential for the MCP endpoint.
  if (body.transport !== undefined && body.transport !== "api") {
    return NextResponse.json({ error: "MCP connections use browser OAuth. Create a REST API key instead." }, { status: 400 });
  }
  const transport = "api" as const;
  const scopes = normalizeScopes(body.scopes);
  const allowedTools = normalizeAllowedTools(body.allowedTools);
  if (allowedTools.length === 0) {
    return NextResponse.json({ error: "Choose at least one product area or tool." }, { status: 400 });
  }
  const minted = await mintApiKey(actor.db, {
    userId: actor.userId,
    name,
    scopes: scopes.length ? scopes : productAreaSelectionsForTools(allowedTools),
    allowedTools,
    transport,
  });
  if (!minted) return NextResponse.json({ error: "Could not create the key." }, { status: 500 });

  track("api_key_created", actor.userId, {
    transport,
    write: allowedTools.some((tool) => API_KEY_WRITE_TOOL_NAMES.has(tool)),
  });
  // `token` is returned here and nowhere else, ever.
  return NextResponse.json({ key: minted.key, token: minted.token }, { status: 201 });
}
