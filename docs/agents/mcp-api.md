# MCP server and public tool API

PropLane exposes the manager tool registry over two bearer-authenticated,
server-to-server transports:

- `POST /api/mcp` — stateless Streamable HTTP using JSON-RPC (`initialize`,
  `tools/list`, `tools/call`, and `ping`).
- `GET /api/v1/tools` and `POST /api/v1/tools/:name` — the same catalog and
  dispatcher for clients that do not speak MCP.

The source of truth is `src/lib/mcp/gateway.ts`. Never add a third dispatch or
confirmation implementation: this gateway calls the existing registry,
`runReadTool`, and `previewWriteTool`; a signed-in manager approves the resulting
pending action through the existing `runConfirmedPendingActionForPortal` path.

## Credential and authorization model

`manager_api_keys` is a trust table. It is RLS enabled with no policies and
explicitly revokes browser DML from `anon` and `authenticated`; every access is
through a service-role route after the caller has been authenticated.

Keys have the form `pl_live_<32 random bytes as base64url>`. The server returns
the plaintext exactly once from `POST /api/manager/api-keys`; it stores only
`sha256(token)` and a short display prefix. Do not log, persist, or return a
plaintext key from any later endpoint.

**A key is a credential, never standing authorization.**
`resolveApiKeyContext` hashes and looks up the token, rejects revoked and
expired rows, then re-derives the manager/owner/admin role on every request.
It creates the ordinary manager `AgentContext` only after that check. A role
change therefore removes a key's power immediately; never cache roles on the
key row or trust a role supplied by the harness.

The MCP route intentionally ignores cookies and permits cross-origin bearer
requests. Do not add cookie reads to it without replacing the wildcard CORS
policy in the same change.

## Connection types, product permissions, and the write gate

**MCP** at `/api/mcp` is a remote OAuth 2.1 protected resource. An unauthenticated
client receives `WWW-Authenticate` with protected-resource metadata, dynamically
registers, uses PKCE S256, signs the manager into PropLane in a browser, and gets
short-lived access/rotating refresh tokens. `mcp_oauth_*` tables are all
service-role-only. The resulting MCP connection has the complete manager assistant
surface; its writes are still previewed and await a manager’s in-product approval.
Managers can disconnect any active MCP client from Settings → API & MCP; this
revokes every active token for that manager/client grant immediately. Clients
may also use the advertised RFC 7009 revocation endpoint.

**REST API** at `/api/v1/tools` uses manually created, bearer API keys. Do not make
these credentials portable between endpoints; separate credentials make revocation
and audit boundaries clearer.

REST API key managers grant access by product area, with compact Read and Write controls.
Write includes the area’s read tools. The Advanced tools disclosure can narrow
the resulting selection to individual tool names. New keys store that exact
`allowed_tools` list; it is enforced both in `tools/list` and in the gateway,
so guessing a hidden tool name does not work. The product-area list lives in
`src/lib/mcp/capabilities.ts`; add a new manager tool there before exposing it
to external credentials.

The initial broad `read`/`write` rows are legacy MCP credentials only. New MCP
connections must use OAuth; new REST API keys use an explicit allowlist.

An MCP/REST write call only runs the tool's `preview`, then persists the
validated input and safe `ActionPreview` in `agent_pending_actions`. It returns
an action id and changes nothing. A signed-in manager must review and approve
that proposal from PropLane’s AI drafts; bearer credentials cannot call
`confirm_action` or otherwise self-approve a write. Confirmation reuses the
existing portal-bound claim, stored-input revalidation, audit, and handler path.
MCP never honors `MANAGER_INLINE_WRITE_TOOLS`: every external write is gated.

## Observability and limits

`mcp_tool_called` records tool name, success, and transport in PostHog. Each
direct call is also a Langfuse `axis-mcp-tool-call` trace carrying `landlordId`,
key id, transport, input, and result; manager approvals retain their existing
`axis-agent-action` trace. No customer PII or secrets belong in PostHog event
properties.

Rate limiting is best-effort in-memory: 120 calls/minute per key plus an
unauthenticated IP limiter. On a multi-instance Vercel deployment that is an
abuse brake, not a durable global quota. Introduce a durable limiter before
making a billing or strict-quota promise.

The catalog is deliberate: a newly added tool is not externally available until
it is assigned to a product area in the capabilities file.
