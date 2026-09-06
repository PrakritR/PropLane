/**
 * MCP server — stateless Streamable HTTP.
 *
 * Hand-rolled rather than SDK-backed on purpose: the SDK's main job is turning
 * Zod into JSON Schema, and `toAnthropicTools` already does that. What remains
 * is a JSON-RPC POST handler for five methods. (The official Next adapter,
 * mcp-handler@2, peer-requires zod ^4 while this repo is on zod 3 across ~135
 * tool schemas; mcp-handler@1 pins the SDK to one exact version and hard-depends
 * on redis. Neither trade is worth it for ~150 lines.)
 *
 * Stateless means: no `Mcp-Session-Id`, and GET/DELETE answer 405. That is
 * spec-legal for a server offering no server→client stream, and it is what lets
 * this run on Vercel Functions with no session store.
 *
 * Auth is bearer-only and NEVER reads cookies — that is what makes the wildcard
 * CORS header below safe. If this route ever consults a cookie, the CORS policy
 * has to be locked down in the same commit or it becomes a CSRF hole.
 */
import { NextResponse } from "next/server";

import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { resolveRequestOrigin } from "@/lib/app-url";
import { resolveApiKeyContext } from "@/lib/mcp/context.server";
import { callTool, listTools } from "@/lib/mcp/gateway";

export const runtime = "nodejs";

const SERVER_NAME = "proplane";
const SERVER_VERSION = "1.0.0";

/**
 * Versions we can actually serve. 2026-07-28 is deliberately absent: it adds
 * `server/discover` and a per-request `_meta` envelope this handler does not
 * implement, and claiming a version you do not serve is worse than negotiating
 * down. A 2026-era client receives 2025-06-18 and falls back.
 */
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function oauthAuthenticateHeader(req: Request): string {
  const origin = resolveRequestOrigin(req);
  return `Bearer realm="PropLane MCP", resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result }, { headers: CORS_HEADERS });
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: CORS_HEADERS });
}

/** A tool failure is a RESULT with `isError`, not a JSON-RPC error — per spec, so
 *  the calling model sees the message and can correct itself. */
function toolContent(payload: unknown, isError: boolean) {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
    isError,
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Stateless: there is no stream to resume and no session to delete. */
export async function GET() {
  return NextResponse.json(
    { error: "This MCP server is stateless. Use POST with a JSON-RPC body." },
    { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } },
  );
}

export const DELETE = GET;

export async function POST(req: Request) {
  // Guards enumeration of the key space before any DB work happens.
  if (!(await rateLimit(`mcp-auth:${clientIpFrom(req)}`, 60, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: CORS_HEADERS });
  }

  const auth = await resolveApiKeyContext(req, "mcp");
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      {
        status: auth.status,
        headers: { ...CORS_HEADERS, "WWW-Authenticate": oauthAuthenticateHeader(req) },
      },
    );
  }

  if (!(await rateLimit(`mcp:${auth.keyId}`, 120, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: CORS_HEADERS });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, PARSE_ERROR, "Request body is not valid JSON.", 400);
  }

  if (Array.isArray(body)) {
    // Batching was removed in MCP 2025-06-18. Refusing clearly beats a partial
    // implementation that some client silently depends on.
    return rpcError(null, INVALID_REQUEST, "Batched JSON-RPC requests are not supported.", 400);
  }
  if (!body || typeof body !== "object") {
    return rpcError(null, INVALID_REQUEST, "Request body must be a JSON-RPC object.", 400);
  }

  const message = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (message.jsonrpc !== "2.0") {
    return rpcError(null, INVALID_REQUEST, 'jsonrpc must be "2.0".', 400);
  }
  if (message.id !== undefined && message.id !== null && typeof message.id !== "string" && typeof message.id !== "number") {
    return rpcError(null, INVALID_REQUEST, "Request id must be a string, number, or null.", 400);
  }
  const method = typeof message.method === "string" ? message.method : "";
  // A notification carries no id and MUST NOT get a response body.
  const isNotification = message.id === undefined;
  const id: JsonRpcId = isNotification ? null : (message.id as JsonRpcId);

  if (!method) {
    return isNotification
      ? new NextResponse(null, { status: 202, headers: CORS_HEADERS })
      : rpcError(id, INVALID_REQUEST, "Missing JSON-RPC method.", 400);
  }

  if (isNotification) {
    // `notifications/initialized` and friends: accept and say nothing.
    return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
  }

  switch (method) {
    case "initialize": {
      const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "PropLane property management. Every number, balance, date and status comes from a tool " +
          "result — never compute or estimate one yourself. Tools whose description says the action " +
          "must be confirmed do not change anything when called: they return an actionId and a " +
          "preview, which you must show to the person you are acting for before calling confirm_action.",
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: listTools(auth.allowedTools, auth.scopes) });

    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) return rpcError(id, INVALID_REQUEST, "tools/call requires a tool name.", 400);
      const result = await callTool(
        auth.ctx,
        auth.allowedTools,
        auth.scopes,
        name,
        params.arguments ?? {},
        "mcp",
        auth.keyId,
      );
      return rpcResult(id, result.ok ? toolContent(result.data, false) : toolContent(result.error, true));
    }

    default:
      return rpcError(id, METHOD_NOT_FOUND, `Unsupported method: ${method}`);
  }
}
