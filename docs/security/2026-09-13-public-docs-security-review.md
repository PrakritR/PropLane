# Public documentation security review - 2026-09-13

## Scope and recommendation

**APPROVE for landing from a security perspective. Unresolved Critical: 0. Unresolved High: 0.** Normal release validation and deployment verification remain required; this report is not a claim that those gates completed.

- Branch: `keeper/akhil-docs-succinct`.
- Reviewed base: `origin/main`, resolved to `203d5e58f3ad99e6a977d65b1bbdb69115c52711`.
- Reviewed head: `c6d7db81ae1486bf400164e328e0a293692c03f0`.
- Reviewed all eight changed files: both public documentation pages, `DocsScrollspyNav`, both new unit tests, and the three plan/execution/review artifacts.
- The working tree was clean before review. This report is the reviewer's only durable change. No implementation modification, credentialed service call, seed, production mutation, commit, push, or deployment was performed. No no-mistakes pipeline was invoked.

## Findings and resolution evidence

No new exploitable vulnerability or unresolved security regression was identified in the reviewed diff.

Previously identified security-related documentation findings are resolved in the reviewed head:

| Finding | Severity | Resolution evidence |
| --- | --- | --- |
| Public copy incorrectly excluded application decisions and listing/property tools that the runtime already exposed | Medium, resolved | `/docs/mcp` now describes application decisions, property creation/updates, and listing drafts. `src/lib/mcp/capabilities.ts` includes these operations; `validatePropertyStatusChange` in `src/lib/tools/domains/properties.ts` requires admin review for initial publication and restricts direct live/unlisted transitions. No capability or authorization code changed. |
| Product guide promised confirmation for every built-in assistant write | Medium, resolved | `/docs` now names the immediate inbox-housekeeping exception. `MANAGER_INLINE_WRITE_TOOLS` contains `update_thread`; manager chat passes this allowlist, while the external gateway always stages writes. The universal external approval promise remains accurate. |
| Rate-limit guidance incorrectly limited the IP gate to unauthenticated traffic and equated every 429 with exhausted quota | Medium, resolved | Both external route implementations check 60 requests/minute per IP before authentication, then 120 per credential. `src/lib/rate-limit.ts` uses the shared deployed limiter and fails closed on backend failure. Revised copy explains these distinctions. |

The older root instruction excluding some application/listing tools and the in-memory-only paragraph in `docs/agents/mcp-api.md` still disagree with runtime behavior. These are pre-existing internal documentation discrepancies, explicitly recorded in the phase artifacts. This change neither expands the runtime surface nor waives those policies for future tool work. The corrected public text does not invent a security boundary that callers could mistakenly rely on.

## Security analysis

- **XSS and hash handling:** `docsActiveIdFromHash` decodes inside a try/catch and accepts only an exact member of the authored section-id array. Unknown and malformed fragments cannot become DOM selectors, HTML, executable URLs, or tool input. DOM lookup uses `getElementById` with authored ids. Labels, descriptions, snippets, and metadata render as React text. There is no `dangerouslySetInnerHTML`, raw HTML insertion, evaluation of page input, or user-authored regular expression. Description normalization uses fixed patterns and preserves tool identifiers.
- **URL behavior:** TOC destinations are literal fragment links from static navigation groups. The change introduces no redirect logic, URL construction from request headers, external script, or new external destination. Passive scrolling does not mutate history. The MCP example retains the fixed HTTPS production origin and a visibly placeholder OAuth token; no real credential is embedded.
- **Server/client boundary:** Both page modules remain Server Components. Only `DocsScrollspyNav` is a Client Component, imports React alone, and receives authored strings and navigation groups. The server-side tool registry is not imported by this client boundary. This agrees with the installed Next.js server/client component guide. Public catalog rendering exposes the existing intended names, kinds, and descriptions, not handlers, secrets, tenant rows, or credentials.
- **Authentication and authorization guidance:** `context.server.ts` reads bearer headers, ignores cookies, enforces transport separation, re-derives manager access, and derives both actor and landlord ids from the credential. `api-keys.server.ts` stores SHA-256 token hashes and a non-secret display prefix. OAuth code checks client/redirect/PKCE binding, claims codes once, rotates refresh tokens, and checks expiry/revocation when resolving access tokens. Revocation and transport isolation remain correctly documented.
- **Write safety:** `gateway.ts` refuses `confirm_action`, independently checks tool allowlists at dispatch, and uses `previewWriteTool` plus server-stored pending actions for every external write. The confirmation path checks caller portal and user ownership, claims only an unexpired proposed action, returns 410 on an unavailable/replayed action, and revalidates stored input through the current tool schema before executing. The default external proposal lifetime is 900 seconds. Public copy preserves the warning that resident/applicant text is untrusted data.
- **Production/data exposure:** No API route, middleware, tool, dependency, migration, RLS policy, deployment configuration, or database access was changed. Static documentation contains no new account-derived payload. Permission/private-document statements retain the existing product boundaries. The report assesses this bounded change, not the correctness of every existing tool handler or every historical production row.

## Independent validation

1. `npx vitest run tests/unit/docs-scrollspy-nav.test.tsx tests/unit/public-mcp-tool-descriptions.test.ts tests/unit/mcp-api-key-auth.test.ts tests/unit/mcp-tool-scope.test.ts tests/unit/mcp-jsonrpc.test.ts tests/unit/mcp-oauth-metadata.test.ts tests/unit/mcp-oauth-revocation.test.ts tests/unit/mcp-oauth-deny.test.ts tests/unit/manager-api-keys-route.test.ts tests/unit/tools/pending-actions.test.ts tests/unit/agent-pending-actions-route.test.ts tests/unit/rate-limit.test.ts`: **exit 0; 12 files, 48 tests passed**.
2. An in-memory Node/TypeScript probe executed the actual navigation exports: **exit 0**. It rejected 12 adversarial fragments, including malformed UTF-8, null bytes, encoded HTML, a JavaScript-scheme string, protocol-relative text, prototype names, attribute-like injection, double encoding, and a 100,000-character unknown id. It accepted an encoded allowlisted id. Static React rendering escaped hostile group/link labels and retained the authored fragment destination. The probe wrote no repository files.
3. `npx eslint 'src/app/(public)/docs/page.tsx' 'src/app/(public)/docs/mcp/page.tsx' src/components/docs/docs-scrollspy-nav.tsx tests/unit/docs-scrollspy-nav.test.tsx tests/unit/public-mcp-tool-descriptions.test.ts`: **exit 0**.
4. `git diff --check origin/main c6d7db81a`: **exit 0**.

The graphify query was attempted with both its default path and `.graphify/graph.json`; neither graph exists in this checkout. Review therefore used direct source and tests. No graph artifact was modified. Full build, full unit suite, browser QA, authenticated integration tests, staging QA, and live checks were not rerun by this security reviewer. Earlier browser/build evidence is retained in the phase artifacts and is not represented here as independent validation.

## Final uncommitted correction review - 2026-09-13

Re-reviewed the final uncommitted diff above head `c6d7db81ae1486bf400164e328e0a293692c03f0`, with base `origin/main` still at `203d5e58f3ad99e6a977d65b1bbdb69115c52711`. The exact implementation contents reviewed have these Git blob hashes:

- `src/components/docs/docs-scrollspy-nav.tsx`: `42499854e81077ac520f0704933863a2e45dfd1e`.
- `tests/unit/docs-scrollspy-nav.test.tsx`: `5abfc056c5916be215bddc9dde61ab2d095534a1`.

The implementation diff changes only desktop navigation classes: a dynamic-viewport height cap, vertical scrolling, overscroll containment, horizontal inset, four-pixel bottom inset, and zero top padding. The added test asserts the selected height/overflow/inset classes. These values are fixed source literals; no untrusted style, URL, HTML, or selector input is introduced. Hash validation, event handlers, native anchor semantics, React escaping, server/client boundaries, authentication, authorization, catalog exposure, and production behavior remain unchanged. No new security finding results from this correction.

Also reviewed the three untracked release reports: this security report, `2026-09-13-public-docs-bugbot-review.md`, and `2026-09-13-public-docs-rendering-native-review.md`. They contain review evidence, source references, revision identifiers, and local QA details, with no credential or customer-data disclosure identified. They do not add executable application behavior. The rendering report's final disposition verifies the bottom-focus inset and resolves the earlier Medium layout finding; the remaining Bugbot Low/P3 lifecycle-test suggestion is non-blocking and unrelated to a demonstrated security defect.

Independent final validation: `npx vitest run tests/unit/docs-scrollspy-nav.test.tsx tests/unit/public-mcp-tool-descriptions.test.ts` exited **0**, with **2 files and 10 tests passed**. `git diff --check` exited **0** before this report append. The release coordinator reports full-unit and Chromium/WebKit checks green; those broader runs were not repeated by this security reviewer.

**Final security recommendation: APPROVE the reviewed head plus the exact uncommitted correction above for landing and shipping through the authorized release process. Unresolved Critical: 0. Unresolved High: 0.** No additional security correction is required. All normal release/deployment gates remain applicable. This follow-up modifies only this report and performs no implementation edit, commit, push, deployment, production action, or no-mistakes invocation.
