# MCP server and public tool API

PropLane exposes the manager tool registry (and, for a resident who connects
"As resident", the resident registry) over two bearer-authenticated,
server-to-server transports:

- `POST /api/mcp` — stateless Streamable HTTP using JSON-RPC (`initialize`,
  `tools/list`, `tools/call`, and `ping`).
- `GET /api/v1/tools` and `POST /api/v1/tools/:name` — the same catalog and
  dispatcher for clients that do not speak MCP.

Both are PULL transports. The PUSH half — outbound, HMAC-signed, read-only
webhooks a manager registers in the same Settings panel — is
[`webhooks.md`](webhooks.md); it shares this file's credential posture (no
client grants, service-role routes, secret shown once) but not its tool layer.

The source of truth is `src/lib/mcp/gateway.ts` (manager) and
`src/lib/mcp/resident-gateway.ts` (resident). Never add a third dispatch or
confirmation implementation: the manager gateway calls the existing registry,
`runReadTool`, and `previewWriteTool`; a signed-in manager approves the resulting
pending action through the existing `runConfirmedPendingActionForPortal` path.

## Credential and authorization model

`manager_api_keys` is a trust table. It is RLS enabled with no policies and
explicitly revokes browser DML from `anon` and `authenticated`; every access is
through a service-role route after the caller has been authenticated.

Keys have the form `pl_live_<32 random bytes as base64url>`. The server returns
the plaintext exactly once from `POST /api/manager/api-keys`; it stores only
`sha256(token)` and a short display prefix. Do not log, persist, or return a
plaintext key from any later endpoint. There is no rotate endpoint either: the panel's
**Rotate** mints a replacement key with the same name and `allowed_tools` through that same
POST and then revokes the old row.

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

The browser half is two screens, both inside the sign-in split shell
(`AuthSplitShell`, `src/app/mcp/layout.tsx`) as label/value rows with no subtext.
**`/mcp/authorize`** is the consent screen: Signed in as, Workspace (it refuses with
"Pick a workspace first" rather than minting a connection with no workspace), App,
Can read, Can do (drafts you approve in PropLane), then
Allow / Cancel. `POST /api/mcp/oauth/approve` then lands on **`/mcp/connected`**
("Connected") and continues to the client's callback after a beat. That
screen is reached with a 2-minute HMAC token (`signMcpConnected`, domain-separated
from the approval signature) carrying the already-validated callback, so it can
never redirect anywhere the approve route did not itself build; it renders only for
the signed-in manager who just approved, and a copied link is inert. A token that
cannot be signed falls back to redirecting straight to the callback.

### What a connection is: one portal, one workspace

A connection is bound at consent to exactly ONE target, stored on the grant
(`mcp_oauth_authorization_codes` / `mcp_oauth_tokens`: `portal` `manager|resident`,
`workspace_id`), carried unchanged through the code exchange and every refresh, and
never read from a request. **Connecting twice gives two connections**: connect once
per workspace, and once more "As resident" if you want both.

The `/mcp/authorize` **Connect as** dropdown (`src/lib/mcp/consent.server.ts`) lists:

- every workspace the portal switcher lists (`listViewerWorkspaces`: owned,
  co-managed, PropLane Service seats), and
- every PropLane-managed (`is_service`) workspace the viewer STAFFS, from the
  same resolver the admin service shell uses (`loadServiceStaffWorkspaces`), so a
  platform admin or service staffer picks Ambika's or Vinod's workspace and
  edits it. Never a client-supplied id: the approve route re-derives the list and
  refuses a posted `target` that is not on it (`resolveMcpTarget`). If the staff
  read fails, a service workspace the viewer does not own is not offered.
- **As resident**, when the account holds a resident role.

**Manager connection.** `resolveApiKeyContext` builds the same manager
`AgentContext` the service shell does (`loadWorkspaces` membership: staff seat,
owner of record, house scope, `managerSmsAccess` for co-manager/staff widening,
Property-owner seat withheld). Re-derived on EVERY request and STRICT: the stored
workspace must still be in the viewer's membership, otherwise 403. It never falls
back to the holder's own workspace, so a revoked seat loses the workspace on the
next call. Writes are previewed and parked; the managed read-only lock still
applies at approval.

**Resident connection.** `resolveMcpBearerContext` sees `portal = resident` and
builds the resident portal's own context (`resolveResidentAgentContextForUser`,
the same builder as `resolveResidentAgentContext`, every request; a lapsed
resident role is a 403). Tools are `buildResidentRegistry(ctx)` only (the portal's
phase/plan filtering, plus its portal-channel `find_homes_on_proplane`), every
read scoped on `resident_user_id`. A resident write is previewed and parked as
`agent_pending_actions` with `portal: "resident"`; the resident confirms it in the
resident portal, as with the portal assistant. `/api/mcp` dispatches on the
grant's portal to ONE gateway; `gateway.ts` never imports the resident registry
and `resident-gateway.ts` never imports the manager one
(`tests/unit/mcp-resident-connection.test.ts` fails a crossing, both ways). A
resident can disconnect from the same `mcp-connections` routes.

**Connect Claude** (Settings → API & MCP for managers, Settings → Preferences for
residents; `src/components/mcp/connect-claude-block.tsx`) shows the MCP URL
`https://proplane.ai/api/mcp` with an icon Copy and one instruction list: Claude →
Settings → Connectors → Add custom connector → paste the URL → sign in → pick a
workspace or "As resident". The URL and steps live in `src/lib/mcp/public-url.ts`.

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

Deployed rate limiting uses a shared Supabase counter and fails closed when
unavailable (a 503 with `Retry-After`, never a bare 429). Every limit is in
`src/lib/mcp/rate-limits.ts`. Local development and tests use an in-memory
counter. These limits are an abuse brake, not a daily billing quota.

Sized for a normal Claude client, which does discovery + one registration + one
token exchange + `initialize` / `tools/list` / a few calls in seconds, from SHARED
Anthropic egress addresses. "Too Many Requests" on connect came from the old
`mcp-auth:<ip>` gate (60/min per IP) spent on every call before auth. Now:

- Discovery (`/.well-known/*`) and a request with no credential: not limited, no lookup.
- `/api/mcp` authenticated: 300/min per grant (key or OAuth token), never per address.
- `/api/mcp` failed credentials: 30/min per IP, counting failures only.
- Registration: 60/min per IP. Token endpoint: 120/min per IP and 60/min per client id.

The catalog is deliberate: a newly added tool is not externally available until
it is assigned to a product area in the capabilities file. `EXTERNAL_EXCLUDED_TOOL_NAMES`
is the one exclusion list and it applies to every direct MCP and REST credential,
legacy broad keys included: metered Brave property-location research
(those calls have no assistant-turn search budget) and `update_room_block`, the hold
editor, which stays assistant-only for now.

`read_spreadsheet` is a deliberate result-shape change for external clients
(Oct 2026): the sheet's cells now come back as one `untrustedContent` envelope
rather than top-level `headers` / `rows`, and `limit` caps at 200 rows. Spreadsheet
text is third-party input, so it is quoted as data a model must not obey; a client
that parsed the old shape reads the envelope instead.
