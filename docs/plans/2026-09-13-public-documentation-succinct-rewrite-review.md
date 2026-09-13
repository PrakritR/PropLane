# Findings

1. **P2 - The unavailable-tools guarantee contradicts the actual external catalog.**
   `src/app/(public)/docs/mcp/page.tsx:227` says application approval and listing creation/editing are unavailable as tools. The same page renders `update_application_bucket`, `create_property`, `update_property`, `create_listing_draft`, and `update_listing_draft`. These are also externally allowlisted at `src/lib/mcp/capabilities.ts:31` and `src/lib/mcp/capabilities.ts:38`. `update_application_bucket` explicitly accepts `approved` and previews “Approve application” (`src/lib/tools/domains/applications.ts:160`, `src/lib/tools/domains/applications.ts:194`); `update_property` supports rent, description, and live/unlisted changes (`src/lib/tools/domains/properties.ts:422`). This is a false capability boundary, although all external writes still require confirmation. The exclusion already existed in the old guide; the rewrite retains it and expands it to editing. The plan and root instructions also assert this exclusion, so there is an existing policy/runtime conflict. **Correction:** reconcile that conflict explicitly before presenting an unavailable-tools guarantee. Describe the approved current boundary accurately, including draft versus publication limits. Do not silently remove catalog entries or change gateway behavior within this documentation rewrite.

2. **P2 - The product guide promises a confirmation gate that manager chat does not universally enforce.**
   `src/app/(public)/docs/page.tsx:265` says every write is previewed and explicitly confirmed. Manager chat passes `MANAGER_INLINE_WRITE_TOOLS` into the loop (`src/app/api/agent/chat/route.ts:173`), and that allowlist includes `update_thread` (`src/lib/tools/index.ts:275`). Marking a thread read/unread, archiving, and restoring run without a confirmation card (`src/lib/tools/domains/inbox.ts:179`). A reader could rely on the stated opportunity to review an inbox change that instead happens immediately. This is an inherited overstatement retained in rewritten copy. **Correction:** briefly qualify the built-in assistant's low-risk inbox exception while retaining the universal approval guarantee specifically for external MCP/REST writes.

3. **P2 - The new rate-limit explanation misidentifies when the IP limit applies and what 429 proves.**
   `src/app/(public)/docs/mcp/page.tsx:248` describes a lower “unauthenticated” limit and says 429 means a quota was exceeded. The 60/minute IP check executes before authentication for every request, including valid bearer calls (`src/app/api/mcp/route.ts:92`, `src/app/api/v1/tools/[name]/route.ts:20`). An authenticated integration can therefore hit the IP ceiling before its 120/minute credential ceiling. The shared limiter also returns `ok: false` on backend/configuration failure (`src/lib/rate-limit.ts:36`), which these routes map to 429. **Correction:** describe the shared pre-authentication IP limit and avoid asserting that every 429 proves excessive traffic. The in-memory-only description in `docs/agents/mcp-api.md` is stale: current deployed-runtime code uses a shared database limiter and fails closed. Do not copy that stale implementation claim into the public guide.

4. **P2 - The service lifecycle is actually the vendor invoice lifecycle.**
   `src/app/(public)/docs/page.tsx:213` labels `submitted, approved, scheduled, paid` as the states services move through. Those are invoice states (`src/lib/vendor-invoices.ts:8`), and even invoices can go directly from approved to paid (`src/lib/vendor-invoices.ts:26`). Maintenance uses open/scheduled/completed buckets (`src/data/demo-portal.ts:218`), while add-on requests use pending/approved/denied/returned (`src/lib/service-requests-storage.ts:22`). The rewritten sentence retains the old conflation and sends readers looking for statuses the Services surface does not use. **Correction:** remove the status enumeration or identify it precisely as invoice processing with scheduling optional; keep maintenance and add-on requests distinct.

5. **P3 - Generated public descriptions still contain em dashes.**
   `src/app/(public)/docs/mcp/page.tsx:403` normalizes service terminology but leaves punctuation unchanged before rendering at `src/app/(public)/docs/mcp/page.tsx:387`. Both generated HTML inspection and Chromium found em dashes in the descriptions of `list_co_managers`, `amend_lease`, `approve_and_pay_work_order`, `decide_service_request`, and `record_income`. Scanning the two page source files cannot detect these imported strings. **Correction:** normalize em dashes in the public display adapter without changing registry descriptions or tool identifiers, then scan rendered prose. This is an unmet explicit acceptance criterion, not a request to rewrite the registry.

## Scope and independent evidence

Reviewed on 2026-09-13 in `keeper/akhil-docs-succinct`, HEAD `203d5e58f3ad99e6a977d65b1bbdb69115c52711`. Inspected the complete tracked diff, the new navigation component and tests, the plan and handoff, applicable repository instructions, the installed feature-cycle skill, MCP guidance, website/design standards, and Next 16 server/client component guidance. Followed source references through catalog, credential resolution, gateway, confirmation, limiter, and relevant product models. No implementation files were changed.

### Navigation and rendering

- Both page modules remain Server Components. The shared `DocsScrollspyNav` alone owns browser state and effects; its props are serializable groups and strings. The catalog remains server-side. Initial state depends only on props, and browser globals are accessed in the effect, avoiding server-render/hydration divergence.
- All 11 product anchors and all eight MCP anchors survive. MCP navigation order matches the reordered DOM sections. Internal fragment links resolve, and existing CTA/support destinations remain. The added `/pricing` destination exists. The profile destination uses the existing portal routing structure. No new external destination was introduced.
- Independent Chromium geometry checks passed on both real documentation routes at 375x812, 768x900, and 1280x900: document width equals viewport width; all TOC targets are at least 40px high; all 19 links have distinct route-specific `data-attr` values; exactly one link carries `aria-current="location"`.
- Downward and upward checks exercised every section at each width. Bottom-of-document selection returned `trial` and `security`. Passive scrolling changed neither the hash nor history length. Navigation uses real anchors and does not prevent native browser behavior.
- Direct valid hashes (`team`, `rest`) activated the target; unknown and malformed `%` hashes safely selected the first section on fresh loads. Click selection was observable by the next microtask. All 19 mobile anchor clicks were rechecked after the native scroll reached the target's 96px margin and settled on the expected item.
- An initial fixed 600ms click check was too short for long smooth scrolls, particularly across the MCP catalog. Waiting for actual target arrival resolved those observations. They are test timing artifacts, not implementation defects. During smooth scrolling the highlight follows intermediate visible sections, then settles on the clicked target.
- Keyboard Tab navigation produced native anchor focus and a visible two-pixel token-based ring with offset. Active foreground, left border, and background wash derive from `--primary`. Desktop screenshots show a sticky rail with clear active selection; mobile screenshots show the complete index before the content. No new visual defect was identified in those layouts.
- MCP's four mobile code blocks scroll internally: client width 333px, scroll widths 568/426/576/388px. The page itself does not overflow.
- Resizing the viewport changed the reading marker and selected the newly appropriate section on both routes. Removing a section in the browser did not throw or break selection of remaining sections. The implementation queries fresh geometry rather than caching stale positions.
- An additional in-memory harness executed the actual effect with controlled geometry and events: valid-hash initialization, requestAnimationFrame coalescing, resize, malformed-hash fallback, missing-section fallback, pending-frame cancellation, and removal of all three listeners passed. Cleanup uses the same function references as registration.
- Limitation of missing-section handling: hash validation checks navigation membership, not DOM presence. A stale link/hash for an absent section can select that link until viewport selection next runs. Neither current page has a missing target; this is not a current-route blocker.
- Browser checks reported no page errors. Screenshots were inspected and then removed; they are not additional durable artifacts.

### Catalog, copy, and security

- The generated catalog contains 37 reads and 78 writes, 115 unique tools. Its rendered names exactly match all 115 current external capability names, with no omissions or extras. Read/write filters, dynamic counts, sorting, tool identifiers, and the existing first-sentence truncation remain intact. Only the public vocabulary adapter is new.
- Authored page text contains neither legacy service wording nor em dashes. Generated descriptions use service vocabulary, but fail the em-dash criterion as finding 5 documents. Underscored protocol/tool identifiers remain unchanged.
- The prose is materially shorter and easier to scan: task-led openings, a three-step start, parallel workflow lists, and a clear connection comparison. The remaining short trial CTA preserves its old anchor. There is no need for a broader design or content framework change.
- Product claims about private signed document links, double-entry accounting, deposit liability classification, and explicit property/module grants agree with their area documentation and source. The annual price values are $192 versus $20/month and $1,920 versus $200/month (`src/data/manager-plan-tiers.ts:55`, `src/data/manager-plan-tiers.ts:80`), supporting the guide's 20% figure. Separate “two months free” pricing copy is inconsistent, but does not make this guide's percentage wrong.
- MCP setup retains browser authorization, OAuth 2.1, dynamic registration, PKCE S256, short-lived access tokens, and rotating refresh tokens. REST uses explicit tool allowlists; transport credentials are isolated; list and dispatch both enforce scope.
- The external write contract remains accurately described: preview only, validated input stored server-side, manager-bound in-product approval, bearer self-confirmation refused, id-only confirmation, stored-input revalidation, 900-second expiry, atomic single-use claim, and 410 on replay. `MANAGER_INLINE_WRITE_TOOLS` is not honored by the external gateway. Finding 1 concerns the claimed unavailable operations, not a bypass of this approval gate.
- Credential-derived scope, ignored ambient cookies, role revalidation, hashed keys shown once, OAuth disconnection/revocation, and the untrusted resident/applicant text warning remain documented. Runtime role revalidation applies to OAuth as well as REST, although the shortened sentence explicitly names REST.
- REST 200/202/400 tool-result semantics, manager-role 403, MCP `isError`, supported protocol versions, and GET 405 agree with the implementation. Missing/invalid/revoked/expired credentials all use 401; the response bodies are not universally identical, so “indistinguishable” should be read as the documented status category rather than byte-identical errors. Finding 3 covers the materially misleading rate-limit guidance.
- Code examples retain the existing endpoint/input shapes and valid JSON. They were inspected, not executed against a credentialed service.

### Word-count check

An independent TypeScript AST pass counted the same categories before and after: authored JSX text, direct string expressions, visible title/kicker/label/caption attributes, metadata/navigation strings, and snippet literals. Imported generated descriptions and computed catalog content were excluded. The extracted shared “On this page” label contributed three words to each current route.

This pass counted whitespace-delimited tokens after replacing JSX entities with separators. It differs slightly from the handoff's tokenizer; it does not reproduce the handoff's exact totals and does not treat them as independently verified.

| Route | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| `/docs` | 1,208 | 713 | 41.0% |
| `/docs/mcp` | 1,101 | 861 | 21.8% |
| Combined | 2,309 | 1,574 | 31.8% |

The required overall reduction of at least 20% passes independently without counting generated-description shortening.

### Checks and environment limits

- `npx vitest run tests/unit/docs-scrollspy-nav.test.tsx tests/unit/mcp-api-key-auth.test.ts tests/unit/mcp-jsonrpc.test.ts tests/unit/mcp-oauth-revocation.test.ts tests/unit/mcp-tool-scope.test.ts tests/unit/tools/pending-actions.test.ts tests/unit/agent-pending-actions-route.test.ts tests/unit/public-navbar-resources-menu.test.tsx tests/unit/public-get-started-role-picker.test.ts`: exit 0, nine files and 48 tests passed, including all eight TOC tests.
- `npx eslint 'src/components/docs/docs-scrollspy-nav.tsx' 'tests/unit/docs-scrollspy-nav.test.tsx' 'src/app/(public)/docs/page.tsx' 'src/app/(public)/docs/mcp/page.tsx'`: exit 0.
- `git diff --check`: exit 0.
- Independent AST/catalog checks and controlled-effect harness: exit 0. Chromium matrix, hash/focus/resize/catalog pass, and the settled mobile-click pass: exit 0.
- The focused tests meaningfully cover geometry, bottom selection, malformed hashes, click state, ARIA uniqueness, and native focus. The mounted tests do not render target sections or exercise scroll/resize/cleanup events; the focus test asserts classes rather than computed visibility. Browser checks and the temporary effect harness supplied that missing review evidence. A rendered-prose regression check would have caught finding 5.
- The handoff server was no longer running. The configured browser connector failed because Google Chrome was absent. Used installed Playwright Chromium against the existing local production build, with port 3000 already pinned in `.env.local`. The local server was stopped after QA (exit 130 from intentional interruption). No rebuild or environment file edit was needed.
- Browser evidence comes from the existing built routes, checked against current source and rendered copy, rather than a fresh full build. Full TypeScript/focused-build success and interrupted full-build attempts remain handoff evidence; they were not rerun or represented as independent successes.
- `docs/agents/akhil-feature-cycle.md` and `.graphify/graph.json` are absent. The installed skill and supplied phase artifacts were used. No graph rebuild was attempted during this read-only review. The handoff's seed/Stripe and graph-tool problems are environment limitations, not documentation implementation defects.
- No seed, authenticated write, production operation, ticket, no-mistakes invocation, commit, push, PR, merge, or deployment was performed. This review file is the only durable artifact created.

## Correction plan

Correct the five cited documentation issues, resolving the policy/runtime conflict around unavailable tools explicitly. Keep the external approval gate, generated catalog, identifiers, and succinct structure intact. Normalize punctuation only in public display text. Add a focused rendered-copy check for generated vocabulary/punctuation, rerun changed-file lint and the relevant tests, and recheck the affected paragraphs in the browser. Recompute the same authored-only word count after corrections. No TOC algorithm rewrite is indicated by the reviewed routes or independent checks.

CORRECTION PLAN


## Final review after correction loop 1 - 2026-09-13 20:32 UTC

Fresh independent review of the complete current change relative to `origin/main`, including both route rewrites, the untracked shared navigation component, both new tests, and phase artifacts. Branch remains `keeper/akhil-docs-succinct`; HEAD remains `203d5e58f3ad99e6a977d65b1bbdb69115c52711`. The implementation files were reviewed without editing them.

### Remaining finding

**P3 - Public copy still calls PropLane “Axis”, including a newly authored sentence.** `src/app/(public)/docs/mcp/page.tsx:229` now says “Axis admin review is required.” Root `AGENTS.md`, under Brand assets, explicitly requires the user-visible name **PropLane**. This new sentence copies an internal legacy name into the public guide. In addition, the generated display adapter at `src/app/(public)/docs/mcp/page.tsx:401` normalizes service terminology and punctuation but retains seven legacy brand references. The browser renders “Axis vendor portal account”, “outside Axis”, “Axis inbox”, and “Axis ID” in the generated descriptions. These generated occurrences predate this correction, but are in the same public copy surface being normalized.

**Bounded correction:** change the authored phrase to “PropLane admin review” or simply “admin review”. Normalize standalone legacy brand references to PropLane in the public description adapter only. Preserve tool identifiers, schema/property names, and registry descriptions. Extend `tests/unit/public-mcp-tool-descriptions.test.ts:11` with a rendered-prose guard for the retired visible name while retaining its identifier-preservation check. Rerun this test, changed-file lint, and the rendered `/docs/mcp` copy scan. No scrollspy, gateway, registry, authorization, or product behavior change is needed.

### Disposition of the five previous findings

1. **External capability boundary: resolved.** The new paragraph at `src/app/(public)/docs/mcp/page.tsx:227` describes application decisions, property creation/updates, and listing drafts actually exposed by `src/lib/mcp/capabilities.ts`. `update_application_bucket` accepts approved/rejected at `src/lib/tools/domains/applications.ts:160`. The listing publication boundary agrees with `validatePropertyStatusChange` in `src/lib/tools/domains/properties.ts:345`: pending/review rows cannot be published, and relisting requires an unlisted record with a published payload. No catalog entries or authorization gates were changed. The phase artifacts explicitly identify the older policy/runtime disagreement; this documentation patch describes runtime behavior rather than silently altering it. The remaining naming issue above does not invalidate the corrected capability claim.
2. **Built-in assistant approval exception: resolved.** `src/app/(public)/docs/page.tsx:265` now names read/unread, archive, and restore as low-risk inbox operations that may execute immediately. This matches `MANAGER_INLINE_WRITE_TOOLS` and the `update_thread` tool. It separately preserves the universal signed-in manager approval rule for external MCP/REST writes.
3. **Rate limiting: resolved.** `src/app/(public)/docs/mcp/page.tsx:248` identifies the 60/minute pre-authentication IP limit for valid bearer requests as well as unauthenticated traffic, the 120/minute credential limit, and fail-closed backend failure. Source checks of both transport routes and `src/lib/rate-limit.ts` confirm the explanation. It no longer claims that every 429 proves excessive traffic or that deployed limiting is in-memory only.
4. **Service/invoice lifecycle: resolved.** `src/app/(public)/docs/page.tsx:202` distinguishes maintenance from add-on requests, and line 217 explicitly attributes submitted/approved/rejected and optional scheduling to vendor invoices. `VENDOR_INVOICE_ALLOWED_TRANSITIONS` confirms approved invoices may proceed directly to paid.
5. **Generated em dashes: resolved.** `src/app/(public)/docs/mcp/page.tsx:408` normalizes em dashes in public descriptions only. The rendered-page test passes against the actual catalog. Independent Chromium scans found neither em dashes nor legacy service wording in either route's main content at all three widths. Underscored tool identifiers remain intact.

### Independent validation

- `npx vitest run tests/unit/public-mcp-tool-descriptions.test.ts tests/unit/docs-scrollspy-nav.test.tsx tests/unit/services-vocabulary.test.ts tests/unit/mcp-api-key-auth.test.ts tests/unit/mcp-jsonrpc.test.ts tests/unit/mcp-tool-scope.test.ts tests/unit/mcp-oauth-revocation.test.ts tests/unit/tools/pending-actions.test.ts tests/unit/agent-pending-actions-route.test.ts tests/unit/rate-limit.test.ts`: exit **0**, 10 files and **43 tests passed**.
- `npx eslint 'src/app/(public)/docs/page.tsx' 'src/app/(public)/docs/mcp/page.tsx' src/components/docs/docs-scrollspy-nav.tsx tests/unit/docs-scrollspy-nav.test.tsx tests/unit/public-mcp-tool-descriptions.test.ts`: exit **0**.
- `git diff origin/main --check`: exit **0**.
- Independent source extraction preserved all **11 product anchors and eight MCP anchors**. MCP navigation order matches its reordered sections. Both route modules remain Server Components; the shared navigation alone accesses browser state, exclusively within effects/events. Initial rendering depends on serializable props and has no browser-only initialization divergence.
- Independent authored-only TypeScript AST count: product **1,208 to 766** words; MCP **1,101 to 906**; combined **2,309 to 1,672**, a **27.6% reduction**. Categories were JSX text, direct JSX strings, visible title/kicker/label/caption attributes, metadata/navigation strings, and snippet literals. Imported catalog descriptions were excluded, and the shared three-word navigation label was counted once per route. This tokenizer counts template spans and JSX entities consistently on both revisions; its MCP totals differ from the handoff, but independently clear the 20% overall requirement.
- Chromium used the **current development source**, not a stale production build, at the already pinned `http://localhost:3000`. Both routes were checked at **375x900, 768x900, and 1280x900**; an additional 375x812 MCP screenshot was inspected. Document widths matched the viewport; all navigation targets measured at least 40px; exactly one current link was present; 115 tool rows rendered at every MCP width.
- Every section on both routes was exercised in **both scroll directions at all three widths**. Absolute page-bottom selection chose `trial` and `security`. Every native anchor was clicked and checked after its target reached the 96px scroll margin. Passive scrolling preserved both hash and history length.
- Valid direct hashes `team` and `rest` settled on the corresponding section and current link. Unknown and malformed `%` hashes fell back safely to the first section. A temporary intermediate selection during native smooth scrolling was observed; waiting for actual target arrival confirmed correct final state. One initial fixed 70ms geometry check was too short under dev rendering; the state-based rerun passed the entire matrix.
- Keyboard Tab advanced between native anchors. Computed focus styling included the visible cobalt two-pixel ring and offset. The desktop screenshot showed the active rail, clear prose hierarchy, and preserved spacing. Mobile retained the full index above the content. All four mobile code blocks scrolled internally: client width 333px, scroll widths 568/426/576/388px. No page error or warning was reported by the final browser console check.
- An independent in-memory harness executed the actual transpiled effect, with controlled DOM geometry and events. Valid-hash initialization, downward/upward selection, bottom selection, malformed-hash fallback, resize, missing sections, requestAnimationFrame coalescing, pending-frame cancellation, and same-reference removal of all three listeners passed, exit **0**.
- Tests meaningfully cover selection, hashes, click/ARIA behavior, and real generated prose. Their mounted navigation cases do not themselves drive geometry/resize/cleanup; the independent runtime harness and browser checks supplied that review evidence. The new generated-copy test catches the previous punctuation defect without changing the source registry.

### Scope and limitations

The normal CLI browser launch initially failed because system Google Chrome is absent (exit 1). The installed Playwright Chromium executable worked through a temporary CLI configuration. Screenshots and review-only helper configuration were temporary; no implementation or environment file was edited. The existing port pin was verified before starting the server.

`docs/agents/akhil-feature-cycle.md` and the graph state remain absent. `graphify query` failed with graph-not-found (exit 1), so source review was used. No graph rebuild was attempted in this read-only phase. The installed feature-cycle skill, plan, handoff, prior review, MCP/source guidance, website standards, and installed Next server/client-boundary guidance were read.

Full TypeScript checking and the focused production build remain execution-handoff evidence; they were not rerun or claimed as independent successes here. The interrupted full builds, incomplete dev/test seed caused by the placeholder Stripe key, and graph tooling limitations remain documented environment limits. Public documentation rendering does not depend on seeded account rows. No authenticated action, seed, production change, commit, push, PR, deployment, ticket, or no-mistakes command was performed.

The five prior corrections are verified. Only the bounded public-brand wording correction above remains before approval.

CORRECTION PLAN


## Final approval review after correction loop 2 - 2026-09-13 20:44 UTC

Fresh review of the entire current diff from `origin/main`, including both route pages, the untracked shared navigation component, both new tests, and the plan/execution/review artifacts. Branch is `keeper/akhil-docs-succinct`; HEAD is `203d5e58f3ad99e6a977d65b1bbdb69115c52711`. No implementation file was modified during this review.

### Findings and correction disposition

No remaining implementation finding.

The loop-2 correction is correctly bounded. The authored publication explanation now says **PropLane admin review**. `publicToolDescription` replaces whole-word `Axis` only in rendered description prose, after the existing first-sentence extraction. Registry descriptions, tool names, schema names, catalog membership, and authorization behavior are unchanged. The rendered-page regression rejects the old visible brand, em dashes, and legacy service wording; it positively checks PropLane inbox, vendor portal account, outside PropLane, and ID wording, and verifies every catalog tool identifier remains present. All five phrases, including the authored admin-review phrase, were independently verified in Chromium.

The previous five findings remain resolved:

1. The external capability paragraph matches the application/property/draft tools in `capabilities.ts` and the publication boundary in `validatePropertyStatusChange`. The existing policy/runtime discrepancy remains explicit in the phase artifacts; this change does not alter runtime capabilities.
2. Built-in manager inbox housekeeping is explicitly qualified. The external MCP/REST approval guarantee stays universal, matching the gateway's preview-only dispatch and refusal of bearer confirmation.
3. Rate-limit copy describes the pre-authentication 60/minute IP limit, the 120/minute credential limit, and fail-closed backing-service failure. Both transport routes and the limiter were checked directly.
4. Maintenance, add-on requests, and vendor invoices remain distinct. Optional invoice scheduling agrees with `VENDOR_INVOICE_ALLOWED_TRANSITIONS`.
5. Generated descriptions normalize punctuation and service terminology only at the public display boundary. Rendered copy scans passed on both routes at every tested width.

### Independent validation

- `npx vitest run tests/unit/public-mcp-tool-descriptions.test.ts tests/unit/docs-scrollspy-nav.test.tsx tests/unit/services-vocabulary.test.ts tests/unit/mcp-api-key-auth.test.ts tests/unit/mcp-jsonrpc.test.ts tests/unit/mcp-tool-scope.test.ts tests/unit/mcp-oauth-revocation.test.ts tests/unit/tools/pending-actions.test.ts tests/unit/agent-pending-actions-route.test.ts tests/unit/rate-limit.test.ts`: exit **0**, **10 files and 43 tests passed**.
- `npx eslint 'src/app/(public)/docs/page.tsx' 'src/app/(public)/docs/mcp/page.tsx' src/components/docs/docs-scrollspy-nav.tsx tests/unit/docs-scrollspy-nav.test.tsx tests/unit/public-mcp-tool-descriptions.test.ts`: exit **0**.
- `git diff origin/main --check`: exit **0**.
- The source anchor comparison preserved all **11 product anchors and eight MCP anchors**. Navigation ordering matches section ordering. Existing CTA/support destinations and valid example shapes remain intact.
- Both route modules remain Server Components. Only the shared navigation owns browser state; its initial state comes from serializable props, and browser access stays inside effects/events. Listener cleanup and pending-frame cancellation remain correct on source review. Browser rendering produced no hydration error.
- The final Chromium matrix used current development source at the verified existing port pin, `http://localhost:3000`, at **375x900, 768x900, and 1280x900** on both routes. Every section passed downward and upward selection, every native anchor was clicked and checked at its settled 96px scroll margin, and page-bottom selection chose `trial` or `security`. Exactly one current link remained selected; passive scrolling preserved the hash and history length.
- Fresh direct loads with valid hashes (`team`, `rest`), an unknown hash, and malformed `%` passed. One initial harness timeout came from changing only the hash on the same document and incorrectly expecting a top-of-page reset. The browser correctly retained its scroll position and selected the visible section. The corrected full matrix used distinct query URLs for fresh-load cases and passed with exit **0**.
- Both routes retained one H1, distinct navigation `data-attr` values, targets at least 40px high, and document widths equal to the viewport. All **115 tool rows** rendered on MCP at every width. Mobile code blocks scrolled internally (333px client width; 568/426/576/388px scroll widths).
- Keyboard Tab moved between native links with a visible focus ring. Inspected desktop and 375x812 mobile screenshots showed the active cobalt styling, legible hierarchy, sticky desktop rail, and complete mobile index. Final browser console: **0 errors and 0 warnings**; page-error collection was empty.
- Independent consistent authored-only AST count: product **1,208 to 766** words; MCP **1,101 to 906**; total **2,309 to 1,672**, a **27.6% reduction**. Generated catalog descriptions were excluded; the shared three-word navigation label was allocated to each route. The concise, task-led tone remains intact after the factual corrections.

### Limits and scope

Full TypeScript checking and focused production-build success remain execution-handoff evidence, not checks rerun in this review. The documented interrupted full builds and incomplete seed due to the placeholder Stripe key remain environment limitations; these public pages do not depend on seeded account rows. The installed feature-cycle skill and relevant Next client-boundary guide were read. `docs/agents/akhil-feature-cycle.md` and graph state are absent; `graphify query` returned graph-not-found, exit **1**, so this review used direct source evidence. No graph rebuild was attempted in this read-only phase.

This appended review is the only durable file change from the reviewer. No production access, authenticated action, seed, implementation edit, commit, push, PR, deployment, ticket, or no-mistakes invocation occurred.

APPROVED
